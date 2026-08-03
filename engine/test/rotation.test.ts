import { describe, it, expect } from 'vitest';
import { rotateDirection, rotateBoard } from '../src/composer.js';
import { boardWithCornerWall } from './fixtures.js';

describe('rotateDirection', () => {
  it('rotates clockwise in 90deg steps', () => {
    expect(rotateDirection('N', 90)).toBe('E');
    expect(rotateDirection('E', 90)).toBe('S');
    expect(rotateDirection('S', 90)).toBe('W');
    expect(rotateDirection('W', 90)).toBe('N');
  });

  it('handles 180 and 270', () => {
    expect(rotateDirection('N', 180)).toBe('S');
    expect(rotateDirection('N', 270)).toBe('W');
  });

  it('leaves direction unchanged at 0', () => {
    expect(rotateDirection('N', 0)).toBe('N');
  });
});

describe('rotateBoard', () => {
  it('moves the top-left cell to the top-right on a 90deg rotation, and rotates its wall', () => {
    const board = boardWithCornerWall();
    const rotated = rotateBoard(board, 90);

    // top-left (0,0) should now be at top-right (11,0)
    const movedCell = rotated.cells[0][11];
    expect(movedCell.edges.E).toBeDefined();
    expect(movedCell.edges.E?.[0].kind).toBe('wall');
    expect(movedCell.edges.N).toBeUndefined();

    // original position should now hold whatever was at bottom-left
    expect(rotated.cells[0][0].edges.N).toBeUndefined();
  });

  it('180 degrees moves the corner to the opposite corner', () => {
    const board = boardWithCornerWall();
    const rotated = rotateBoard(board, 180);
    const movedCell = rotated.cells[11][11];
    expect(movedCell.edges.S).toBeDefined();
    expect(movedCell.edges.S?.[0].kind).toBe('wall');
  });

  it('four 90-degree rotations return to the original', () => {
    const board = boardWithCornerWall();
    let r = board;
    for (let i = 0; i < 4; i++) r = rotateBoard(r, 90);
    expect(r.cells[0][0].edges.N?.[0].kind).toBe('wall');
  });
});
