import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { composeCourse } from '@roborally/engine';
import type { BoardLibrary, Course, CourseBoardRef, Rotation } from '@roborally/engine';
import { createPool, configFromEnv } from './db.js';

/**
 * STATUS: real, complete.
 *
 * Imports board.json files and course definitions from disk. Boards are
 * authored outside the web server entirely; this is the only path from a
 * file to the database.
 *
 * Reimport behaviour, confirmed by the project owner: a board found to be
 * broken may be fixed and reimported, and courses using it are expected to
 * pick up the fix EVEN IF A GAME IS IN PLAY. The floor changing underneath
 * a running game is the intended behaviour, not a hazard to guard against.
 *
 * That is why boards are keyed `(id, sha256)` and never updated in place:
 * a fix adds a new version, and `course relink` repoints courses at the
 * newest one. Old versions stay so a game's history remains meaningful,
 * and `board prune` clears out ones nothing references.
 *
 * The `Course` type requires a sha256 on every board reference, which
 * would be miserable to write by hand. So an AUTHORED course file omits
 * them and this tool resolves each to the newest imported version. The
 * resolved, complete Course is what gets stored.
 */

// ============================================================
// Authored file formats (what a human writes)
// ============================================================

/** A board reference as authored: no sha256, resolved at import. */
interface AuthoredBoardRef {
  id: string;
  gridX: number;
  gridY: number;
  rotation?: Rotation;
  /** Pin to a specific version instead of taking the newest. Rarely
   * wanted; useful for reproducing an old game. */
  sha256?: string;
}

interface AuthoredCourse {
  name: string;
  boards: AuthoredBoardRef[];
  dock?: AuthoredBoardRef | null;
  flags: { number: number; board: string; x: number; y: number }[];
  lifeTokens: number;
}

// ============================================================
// Boards
// ============================================================

/** sha256 of the file's exact bytes, so an identical reimport is
 * recognised as identical and does not create a duplicate row. */
function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface ImportBoardResult {
  id: string;
  sha256: string;
  status: 'inserted' | 'unchanged';
  width: number;
  height: number;
}

export async function importBoard(
  pool: Pool, path: string, idOverride?: string,
): Promise<ImportBoardResult> {
  const text = await readFile(path, 'utf8');
  const data = JSON.parse(text) as { width: number; height: number };

  if (typeof data.width !== 'number' || typeof data.height !== 'number') {
    throw new Error(`${path}: not a board.json (no width/height)`);
  }

  const id = idOverride ?? basename(path, extname(path));
  const sha256 = hashOf(text);

  const [existing] = await pool.query<RowDataPacket[]>(
    'SELECT 1 FROM boards WHERE id = ? AND sha256 = ?', [id, sha256],
  );
  if (existing.length > 0) {
    return { id, sha256, status: 'unchanged', width: data.width, height: data.height };
  }

  await pool.execute(
    'INSERT INTO boards (id, sha256, width, height, board_json) VALUES (?, ?, ?, ?, ?)',
    [id, sha256, data.width, data.height, text],
  );
  return { id, sha256, status: 'inserted', width: data.width, height: data.height };
}

interface BoardVersionRow extends RowDataPacket {
  id: string;
  sha256: string;
  width: number;
  height: number;
  created_at: Date;
}

/** Newest imported version of a board. */
async function newestVersion(pool: Pool, id: string): Promise<string | null> {
  const [rows] = await pool.query<BoardVersionRow[]>(
    'SELECT sha256 FROM boards WHERE id = ? ORDER BY created_at DESC LIMIT 1', [id],
  );
  return rows[0]?.sha256 ?? null;
}

export async function listBoards(pool: Pool, id?: string): Promise<BoardVersionRow[]> {
  const [rows] = id
    ? await pool.query<BoardVersionRow[]>(
      'SELECT id, sha256, width, height, created_at FROM boards WHERE id = ? ORDER BY created_at DESC',
      [id],
    )
    : await pool.query<BoardVersionRow[]>(
      'SELECT id, sha256, width, height, created_at FROM boards ORDER BY id, created_at DESC',
    );
  return rows;
}

/** Board versions no course refers to. Safe to delete. */
export async function unreferencedBoards(pool: Pool): Promise<BoardVersionRow[]> {
  const all = await listBoards(pool);
  const [courses] = await pool.query<RowDataPacket[]>('SELECT course_json FROM courses');

  const inUse = new Set<string>();
  for (const row of courses) {
    const course = JSON.parse((row as { course_json: string }).course_json) as Course;
    for (const ref of course.boards) inUse.add(`${ref.id}:${ref.sha256}`);
    if (course.dock) inUse.add(`${course.dock.id}:${course.dock.sha256}`);
  }

  return all.filter((b) => !inUse.has(`${b.id}:${b.sha256}`));
}

// ============================================================
// Courses
// ============================================================

async function resolveRef(pool: Pool, ref: AuthoredBoardRef): Promise<CourseBoardRef> {
  const sha256 = ref.sha256 ?? await newestVersion(pool, ref.id);
  if (!sha256) {
    throw new Error(`board "${ref.id}" has not been imported; import it first`);
  }
  return {
    id: ref.id,
    sha256,
    gridX: ref.gridX,
    gridY: ref.gridY,
    rotation: ref.rotation ?? 0,
  };
}

async function libraryFor(pool: Pool, course: Course): Promise<BoardLibrary> {
  const refs = course.dock ? [...course.boards, course.dock] : course.boards;
  const library: BoardLibrary = {};
  for (const ref of refs) {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT board_json FROM boards WHERE id = ? AND sha256 = ?', [ref.id, ref.sha256],
    );
    const row = rows[0] as { board_json: string } | undefined;
    if (!row) throw new Error(`board ${ref.id}@${ref.sha256.slice(0, 8)} is missing`);
    library[ref.id] = { data: JSON.parse(row.board_json), sha256: ref.sha256 };
  }
  return library;
}

/** Resolves an authored course and composes it, so a bad course fails
 * HERE rather than when a player tries to start a game on it. */
async function buildCourse(pool: Pool, authored: AuthoredCourse): Promise<Course> {
  const course: Course = {
    boards: await Promise.all(authored.boards.map((r) => resolveRef(pool, r))),
    dock: authored.dock ? await resolveRef(pool, authored.dock) : null,
    flags: authored.flags,
    lifeTokens: authored.lifeTokens,
  };

  const grid = composeCourse(course, await libraryFor(pool, course));
  if (grid.width === 0 || grid.height === 0) {
    throw new Error('course composed to an empty grid');
  }
  return course;
}

export interface ImportCourseResult {
  id: number;
  name: string;
  status: 'inserted' | 'updated';
  boards: { id: string; sha256: string }[];
}

export async function importCourse(pool: Pool, path: string): Promise<ImportCourseResult> {
  const authored = JSON.parse(await readFile(path, 'utf8')) as AuthoredCourse;
  if (!authored.name) throw new Error(`${path}: course needs a name`);

  const course = await buildCourse(pool, authored);
  const json = JSON.stringify(course);

  const [existing] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM courses WHERE name = ?', [authored.name],
  );
  const found = existing[0] as { id: number } | undefined;

  if (found) {
    // Touching course_json bumps updated_at, which is what invalidates the
    // server's composed-grid cache without a restart.
    await pool.execute('UPDATE courses SET course_json = ? WHERE id = ?', [json, found.id]);
    return {
      id: found.id, name: authored.name, status: 'updated',
      boards: course.boards.map((b) => ({ id: b.id, sha256: b.sha256 })),
    };
  }

  const [insert] = await pool.execute(
    'INSERT INTO courses (name, course_json) VALUES (?, ?)', [authored.name, json],
  );
  return {
    id: (insert as { insertId: number }).insertId,
    name: authored.name,
    status: 'inserted',
    boards: course.boards.map((b) => ({ id: b.id, sha256: b.sha256 })),
  };
}

export interface RelinkResult {
  id: number;
  name: string;
  changed: { boardId: string; from: string; to: string }[];
  activeGames: number;
}

/**
 * Repoints a course at the newest version of every board it uses. This is
 * what a fix-and-reimport cycle ends with.
 *
 * Reports how many games are currently running on the course. It does not
 * refuse: changing the floor mid-game is the intended behaviour. The count
 * is there so the change is not a surprise.
 */
export async function relinkCourse(pool: Pool, courseId: number): Promise<RelinkResult> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, name, course_json FROM courses WHERE id = ?', [courseId],
  );
  const row = rows[0] as { id: number; name: string; course_json: string } | undefined;
  if (!row) throw new Error(`no course with id ${courseId}`);

  const course = JSON.parse(row.course_json) as Course;
  const changed: RelinkResult['changed'] = [];

  const repoint = async (ref: CourseBoardRef): Promise<CourseBoardRef> => {
    const newest = await newestVersion(pool, ref.id);
    if (!newest || newest === ref.sha256) return ref;
    changed.push({ boardId: ref.id, from: ref.sha256, to: newest });
    return { ...ref, sha256: newest };
  };

  const updated: Course = {
    ...course,
    boards: await Promise.all(course.boards.map(repoint)),
    dock: course.dock ? await repoint(course.dock) : null,
  };

  const [games] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM games WHERE course_id = ? AND status = 'active'", [courseId],
  );
  const activeGames = (games[0] as { n: number }).n;

  if (changed.length > 0) {
    // Compose before committing: a relink that produces a broken grid
    // should fail here, not when a player next moves.
    await libraryFor(pool, updated);
    composeCourse(updated, await libraryFor(pool, updated));
    await pool.execute(
      'UPDATE courses SET course_json = ? WHERE id = ?', [JSON.stringify(updated), courseId],
    );
  }

  return { id: row.id, name: row.name, changed, activeGames };
}

export async function allCourseIds(pool: Pool): Promise<{ id: number; name: string }[]> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT id, name FROM courses ORDER BY name');
  return rows as { id: number; name: string }[];
}

// ============================================================
// Command line
// ============================================================

const USAGE = `
rr-import - load boards and courses into the database

  board import <file.json...>     import or reimport boards
  board list [id]                 show imported boards and their versions
  board prune                     delete board versions no course uses

  course import <file.json...>    import or update courses
  course relink <id|all>          repoint courses at the newest boards
  course list                     show courses

Connection settings come from DB_HOST, DB_USER, DB_PASSWORD, DB_NAME.
`.trim();

async function main(argv: string[]): Promise<number> {
  const [group, command, ...rest] = argv;
  if (!group) {
    console.log(USAGE);
    return 1;
  }

  const pool = createPool(configFromEnv());
  try {
    if (group === 'board' && command === 'import') {
      if (rest.length === 0) throw new Error('no files given');
      for (const file of rest) {
        const result = await importBoard(pool, file);
        const mark = result.status === 'inserted' ? 'new ' : 'same';
        console.log(
          `${mark}  ${result.id.padEnd(20)} ${result.sha256.slice(0, 12)}  ${result.width}x${result.height}`,
        );
      }
      console.log('\nRun "course relink all" to point courses at the new versions.');
      return 0;
    }

    if (group === 'board' && command === 'list') {
      for (const b of await listBoards(pool, rest[0])) {
        console.log(
          `${b.id.padEnd(20)} ${b.sha256.slice(0, 12)}  ${b.width}x${b.height}  ${b.created_at.toISOString()}`,
        );
      }
      return 0;
    }

    if (group === 'board' && command === 'prune') {
      const unused = await unreferencedBoards(pool);
      if (unused.length === 0) {
        console.log('Nothing to prune.');
        return 0;
      }
      for (const b of unused) {
        await pool.execute('DELETE FROM boards WHERE id = ? AND sha256 = ?', [b.id, b.sha256]);
        console.log(`deleted  ${b.id} ${b.sha256.slice(0, 12)}`);
      }
      return 0;
    }

    if (group === 'course' && command === 'import') {
      if (rest.length === 0) throw new Error('no files given');
      for (const file of rest) {
        const result = await importCourse(pool, file);
        console.log(`${result.status}  ${result.name} (id ${result.id})`);
        for (const b of result.boards) {
          console.log(`         ${b.id.padEnd(20)} ${b.sha256.slice(0, 12)}`);
        }
      }
      return 0;
    }

    if (group === 'course' && command === 'relink') {
      const target = rest[0];
      if (!target) throw new Error('give a course id, or "all"');

      const targets = target === 'all'
        ? await allCourseIds(pool)
        : [{ id: Number(target), name: '' }];

      for (const t of targets) {
        const result = await relinkCourse(pool, t.id);
        if (result.changed.length === 0) {
          console.log(`unchanged  ${result.name}`);
          continue;
        }
        console.log(`relinked   ${result.name}`);
        for (const c of result.changed) {
          console.log(`           ${c.boardId}: ${c.from.slice(0, 12)} -> ${c.to.slice(0, 12)}`);
        }
        if (result.activeGames > 0) {
          console.log(
            `           note: ${result.activeGames} game(s) in play on this course will pick this up immediately`,
          );
        }
      }
      return 0;
    }

    if (group === 'course' && command === 'list') {
      for (const c of await allCourseIds(pool)) console.log(`${String(c.id).padStart(4)}  ${c.name}`);
      return 0;
    }

    console.log(USAGE);
    return 1;
  } finally {
    await pool.end();
  }
}

// Only runs when invoked directly, so the functions above stay importable.
if (process.argv[1]?.endsWith('import-cli.js')) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: Error) => {
      console.error(`error: ${err.message}`);
      process.exit(1);
    });
}
