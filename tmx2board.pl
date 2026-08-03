#!/usr/bin/perl
use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/lib";   # find the module regardless of cwd
use RoboRally::Tmx qw(xform opposite);
use YAML::PP;
use JSON::PP;
use Getopt::Long;

# tmx2board.pl [--tiles F] [--tsxdir D] map.tmx > board.json
#
# Turns a Tiled map into a board config. Tile meaning comes from the YAML
# table only - layer names in this library are organisational, not semantic.

my ($tiles_file, $tsxdir) = ("$FindBin::Bin/tiles.yml", undef);
GetOptions('tiles=s' => \$tiles_file, 'tsxdir=s' => \$tsxdir) or die;
my $tmx = shift(@ARGV) or die "usage: $0 [--tiles F] [--tsxdir D] map.tmx\n";

my $SEM = YAML::PP->new->load_file($tiles_file);

# Every section records the .tsx it came from, which is the only thing the
# loader needed a .tsx for: a .tmx names files, tiles.yml is keyed by tileset
# name. Handing over the mapping lets a board convert with no .tsx present.
my %NAMES = map  { $SEM->{$_}{file} => $_ }
            grep { defined $SEM->{$_}{file} } keys %$SEM;

my $map = RoboRally::Tmx->load($tmx, tsxdir => $tsxdir, names => \%NAMES);
for my $ts ($map->inferred) {
    warn "note: '$ts->{name}' resolved from tiles.yml, no .tsx read\n";
}

my ($W, $H) = ($map->width, $map->height);
my @cells = map { { level => 0, edges => {}, phases => [] } } 1 .. $W * $H;

# An edge carries a LIST of elements, not one.
#
# It used to hold a single spec, so whichever layer was processed last silently
# destroyed whatever was already there. On TrafficJam5 that lost a north cliff
# under a laser at c1r2 and a two-beam laser under a wall at c8r3 - the labels
# were right and the converter threw the data away. Real boards genuinely stack
# these: a laser is mounted ON a wall, and a bollard can share an edge with a
# cliff.
sub add_edge {
    my ($cell, $dir, $spec) = @_;
    return unless defined $dir;
    push @{ $cell->{edges}{$dir} }, $spec;
    return $spec;
}

# Find an existing element of a given kind on an edge, for the cases that
# legitimately merge rather than stack - layered ledge pieces, mostly.
sub edge_of_kind {
    my ($cell, $dir, $kind) = @_;
    for my $e (@{ $cell->{edges}{$dir} || [] }) {
        return $e if ($e->{kind} // '') eq $kind;
    }
    return undef;
}
my @unknown;

# clockwise compass order, used to derive curve rotations. Declared above
# the code that uses it: a file-scoped `my` below the caller is still empty
# when the caller runs.
my %IDX = (N => 0, E => 1, S => 2, W => 3);

# Terrain lies ON the floor rather than being one: any of it can be the ground
# on its own or be laid over a floor that is already there. Declared up here
# for the same reason %IDX is - a file-scoped my below its caller is empty.
my %TERRAIN = map { $_ => 1 }
    qw(oil slime flamingOil spikes speedBump);

# Ground materials, as against terrain: these are what the square is MADE of,
# so they are the floor rather than something lying on it. A later material
# replaces an earlier one, while a plain `floor` tile never overwrites either.
my %GROUND = map { $_ => 1 } qw(water sand gravel mud);

# A robot entering through $entry travels the opposite way; compare that
# heading with the exit to get the turn it is given going round the corner.
sub turn {
    my ($entry, $exit) = @_;
    return undef unless defined $entry && defined $exit;
    my $d = ($IDX{$exit} - $IDX{ opposite($entry) }) % 4;
    return $d == 0 ? 'none' : $d == 1 ? 'CW' : $d == 3 ? 'CCW' : 'U';
}

sub apply {
    my ($cell, $sem, $flags) = @_;
    my $k = $sem->{kind};
    return if $k eq 'ignore';

    # Almost everything in this game is laid ON a floor tile, so `floor` holds
    # only what the square itself is: open, or a hole of one sort or another.
    # Everything else rides on the cell beside it.
    if    ($k eq 'floor')       { $cell->{floor} //= { kind => 'open' } }
    elsif ($k eq 'pit')         { $cell->{floor} = { kind => 'pit' } }
    # %GROUND is what the square is made of and becomes the floor. %TERRAIN is
    # what has been spilled on it and is collected beside the floor instead, so
    # a hazard laid over a conveyor keeps the conveyor. A cell that ends up
    # with terrain and no floor is given an open one in the post-pass below.
    # Smoke is the same idea for vapour and stays its own flag. Their behaviour
    # lives in the engine; the config records only what is where.
    elsif ($GROUND{$k})         { $cell->{floor} = { kind => $k } }
    elsif ($TERRAIN{$k})        { $cell->{terrain}{$k} = 1 }
    # service squares, laid on a floor like everything else
    elsif ($k eq 'pitStop')     { $cell->{pitStop}  = JSON::PP::true }
    elsif ($k eq 'restStop')    { $cell->{restStop} = JSON::PP::true }
    elsif ($k eq 'stuntRamp') {
        $cell->{stuntRamp} = { entry => xform($sem->{entry}, $flags),
                               exit  => xform($sem->{exit},  $flags) };
    }
    # smoke sits over whatever floor is there and blocks laser fire
    elsif ($k eq 'smoke')       { $cell->{smoke} = JSON::PP::true }
    # Devices sit ON a floor tile rather than being one, so they ride on the
    # cell beside `floor` exactly as pushers, crushers and flamers already do.
    elsif ($k eq 'portal')      { $cell->{portal} = { colour => $sem->{colour} } }
    # a teleporter is its own element, unrelated to a portal, and it sits on a
    # floor space rather than being one
    elsif ($k eq 'teleporter')  { $cell->{teleporter} = JSON::PP::true }
    # each register the chop shop swaps an option/upgrade for a random one or
    # reloads one; on register 5 it grants a new one
    elsif ($k eq 'chopShop')    { $cell->{chopShop} = JSON::PP::true }
    # a robot beginning a register on one draws a random card from the deck
    # and executes it instead of whatever it programmed for that register
    elsif ($k eq 'randomizer')  { $cell->{randomizer} = JSON::PP::true }
    # a place a robot may start on, numbered 1-8, with no other effect. It is
    # a marker on the cell rather than the floor, since the art is an overlay
    # and the square underneath is whatever it is
    elsif ($k eq 'startPosition') { $cell->{start} = $sem->{number} + 0 }
    # a crusher may carry its registers in the art, like a pre-composited
    # pusher, or leave them to phaseDigit tiles layered on top
    elsif ($k eq 'crusher')     { $cell->{crusher} =
        { phases => [ map { $_ + 0 } @{ $sem->{phases} // [] } ] } }
    elsif ($k eq 'flamer')      { $cell->{flamer}  = { phases => [], colour => $sem->{colour} // 'orange' } }
    # A generator pays out 1 energy to a robot that ends a register phase on
    # it. Colour tells the two apart; the effect is the same, as with the
    # flamers, and it rides on the cell rather than replacing the floor.
    elsif ($k eq 'generator')   { $cell->{generator} = { colour => $sem->{colour} } }
    # Radiation and radioactive waste sit alongside the floor rather than
    # replacing it - a conveyor can run across radioactive ground - and they
    # fire at different points: radiation at End of Turn, waste during
    # Resolve Laser Fire (and it offers an Option draw at Touch Checkpoints).
    elsif ($k eq 'radiation')        { $cell->{radiation}        = JSON::PP::true }
    elsif ($k eq 'radioactiveWaste') { $cell->{radioactiveWaste} = JSON::PP::true }
    elsif ($k eq 'repulsor')    { add_edge($cell, xform($sem->{edge}, $flags), { kind => 'repulsor' }) }
    elsif ($k eq 'laser') {
        # an emitter sits on an edge and fires inward, across the cell
        add_edge($cell, xform($sem->{edge}, $flags),
                 { kind => 'laser', count => $sem->{count} + 0 });
    }
    elsif ($k eq 'laserBeam') {
        # a beam crossing the cell with no emitter here. Recorded so the
        # engine can cross-check its own beam tracing against the art.
        push @{ $cell->{beams} },
            { along => xform($sem->{along}, $flags), count => $sem->{count} + 0 };
    }
    elsif ($k eq 'trapDoorPit') { $cell->{floor} = { kind => 'trapDoorPit' } }
    elsif ($k eq 'gear')        { $cell->{gear} = { rotation => $sem->{rotation} } }
    elsif ($k eq 'repair') {
        # every repair space archives the robot each register, so that is not
        # recorded per entry. The icon says what else it does: one wrench
        # heals 1, two wrenches heal 2 OR grant an option on register 5, and a
        # wrench with a hammer heals 1 AND grants an option at the end of
        # register 5 - which is why `hammer` is a flag rather than a third
        # wrench count. It heals the same as a single wrench.
        $cell->{repair} = {
            wrenches => $sem->{wrenches} + 0,
            ($sem->{hammer} ? (hammer => JSON::PP::true) : ()),
        };
    }
    elsif ($k eq 'phaseDigit')  {
        # a cell can carry several timed elements at once, so a digit has to
        # name its owner - that is what the colour and position of the digit
        # sets encode in the art
        push @{ $cell->{phases} }, {
            digit => $sem->{digit} + 0,
            for   => $sem->{for},
            # bollard digits also name which edge(s) they belong to, since a
            # cell can carry bollards on several edges at once
            ($sem->{edges} ? (edges => [ map { xform($_, $flags) } @{ $sem->{edges} } ]) : ()),
        };
    }
    elsif ($k eq 'wall') {
        # Confirmed against real data (Containment6, three wall layers -
        # the most of any board seen): multiple wall tiles can land on the
        # same cell's same edge, and when they carry a `oneWay` colour that
        # disagrees, appending both unconditionally (the old behaviour)
        # produced a genuinely self-contradictory edge - red AND green on
        # the identical side, which can't mean anything coherent. Per the
        # project owner: whichever tile is drawn TOPMOST is what a player
        # actually sees, so it is authoritative outright, not merged
        # attribute-by-attribute. Layers are walked in document order,
        # which is draw order (last-declared = topmost), so the tile
        # processed last for a given edge simply replaces whatever was
        # there before.
        my $edge = xform($sem->{edge}, $flags);
        my $spec = {
            kind => 'wall',
            # a spiked wall damages anything driven, slid or pushed into it
            ($sem->{spikes} ? (spikes => JSON::PP::true) : ()),
            # a one-way wall is a gate: a robot may cross a red one only if it
            # came through the matching green one in the adjacent cell
            ($sem->{oneWay} ? (oneWay => $sem->{oneWay}) : ()),
        };
        my $old = edge_of_kind($cell, $edge, 'wall');
        if ($old) { %$old = %$spec }
        else      { add_edge($cell, $edge, $spec) }
    }
    elsif ($k eq 'cliff') {
        # An elevation edge, and the only asymmetric edge in the format.
        # `drop` names the downhill direction relative to the cell that owns
        # the entry: `in` means the high ground is across the edge, `out`
        # means this cell is the high side. It is relative rather than a
        # compass direction, so the flip flags do not touch it. Every sheet in
        # the library so far draws elevation from below and is `in`; it is
        # still written per entry, because a sheet drawn the other way round
        # would otherwise invert a board with nothing to show for it.
        #
        # Downhill is a fall for 2 damage (times `levels`, see below). Uphill
        # is blocked exactly like a wall, unless the edge carries a ramp: one
        # extra move, or two if the ramp is steep. Ramps have no effect
        # downhill.
        my $drop = $sem->{drop} // '';
        die "cliff on edge $sem->{edge} needs drop: in|out in $tiles_file\n"
            unless $drop eq 'in' || $drop eq 'out';
        my $edge   = xform($sem->{edge}, $flags);
        my $extra  = $sem->{ramp} ? ($sem->{steep} ? 2 : 1) : 0;
        # How many levels this single edge represents. Defaults to 1 - every
        # cliff before this session was a plain single-level drop. Confirmed
        # against real data (Straightaway6): a cliff can represent more than
        # one level, when the art is drawn that way on purpose rather than as
        # ordinary layered partial-piece decoration (see the merge note
        # below - this is NOT inferred from finding two same-edge tiles, it
        # is only ever read from an explicit `levels:` key in tiles.yml).
        my $levels = $sem->{levels} // 1;

        # Ledge art is assembled by layering partial tiles on one cell, so the
        # same edge is often written more than once. That is expected and the
        # library keeps them consistent, so a disagreement is a labelling
        # error and worth hearing about. Keep the ramp if either tile drew one,
        # and likewise keep the larger `levels` if either tile drew one -
        # ordinary decorative layering is two tiles both at the (default) 1,
        # so this only changes anything when a tile explicitly says otherwise.
        my $old = edge_of_kind($cell, $edge, 'cliff');
        if ($old) {
            warn "layered cliffs disagree on edge $edge: drop $old->{drop} then $drop\n"
                if $old->{drop} ne $drop;
            my $was = $old->{ramp} ? $old->{ramp}{extraMoves} : 0;
            $extra = $was if $was > $extra;
            my $was_levels = $old->{levels} // 1;
            $levels = $was_levels if $was_levels > $levels;
            # merge into the piece already there rather than stacking a second
            # cliff on the same edge
            %$old = (kind => 'cliff', drop => $drop,
                     ($extra  ? (ramp   => { extraMoves => $extra }) : ()),
                     ($levels > 1 ? (levels => $levels) : ()));
        }
        else {
            add_edge($cell, $edge, {
                kind  => 'cliff',
                drop  => $drop,
                ($extra  ? (ramp   => { extraMoves => $extra }) : ()),
                ($levels > 1 ? (levels => $levels) : ()),
            });
        }
    }
    elsif ($k eq 'steepMarker') {
        # an overlay laid on a ramp to make it steep. It names the edge its
        # ramp crosses, so it rotates with the tile like any other direction.
        # Recorded here and resolved in the post-pass below, because the ramp
        # it upgrades may come from a later layer.
        push @{ $cell->{steepMark} }, xform($sem->{edge}, $flags);
    }
    elsif ($k eq 'bollard') {
        # a timed wall: a wall on its listed registers, open floor otherwise
        add_edge($cell, xform($sem->{edge}, $flags),
                 { kind => 'bollard',
                   phases => [ map { $_ + 0 } @{ $sem->{phases} // [] } ] });
    }
    elsif ($k eq 'conveyor') {
        # a belt is laid on a floor tile like everything else, so it rides on
        # the cell. That is what lets a pusher or a gear share the square
        my $exit    = xform($sem->{exit}, $flags);
        my @entries = map { xform($_, $flags) } @{ $sem->{entries} };
        $cell->{conveyor} = {
            express => $sem->{express} ? JSON::PP::true : JSON::PP::false,
            exit    => $exit,
            entries => \@entries,
            rotates => { map { $_ => turn($_, $exit) } @entries },
        };
    }
    elsif ($k eq 'current') {
        # A water current: one square along the flow, resolved after conveyors
        # and before pushers. Shaped like a conveyor because the art is - the
        # sheet draws straights and curves - but it is a separate element and
        # a robot in one still obeys the water rules.
        #
        # `rotates` gives the turn a robot arriving from each entry is given,
        # and currents do rotate: a curved current turns a robot 90 degrees
        # the way a curved belt does.
        my $exit    = xform($sem->{exit}, $flags);
        my @entries = map { xform($_, $flags) } @{ $sem->{entries} };
        $cell->{current} = {
            exit    => $exit,
            entries => \@entries,
            rotates => { map { $_ => turn($_, $exit) } @entries },
        };
    }
    elsif ($k eq 'pusher') {
        my $edge = xform($sem->{edge}, $flags);
        # a pusher sits on an edge and pushes away from it, into the board
        $cell->{pusher} = {
            edge   => $edge,
            push   => opposite($edge),
            phases => [ map { $_ + 0 } @{ $sem->{phases} } ],
        };
    }
    else { die "unknown kind '$k' in $tiles_file\n" }
}

$map->each_tile(sub {
    my ($col, $row, $t, $layer) = @_;
    my $sem = $SEM->{ $t->{set} }{ $t->{id} };
    unless (defined $sem) {
        my ($sc, $sr) = $map->sheet_pos($t);
        # sheet position is unavailable when the tileset was resolved from
        # tiles.yml, since that path never reads the sheet geometry
        push @unknown, sprintf('%s tile %d%s - first seen c%dr%d, layer "%s"',
            $t->{set}, $t->{id},
            defined $sc ? sprintf(' (sheet col %d row %d)', $sc, $sr) : '',
            $col, $row, $layer->{name});
        return;
    }
    # one tile can carry several elements - a crusher sitting on a conveyor,
    # for instance - so a table entry may be a single spec or a list of them
    apply($cells[ $row * $W + $col ], $_, $t->{flags})
        for (ref $sem eq 'ARRAY' ? @$sem : $sem);
});

if (@unknown) {
    my %seen;
    print STDERR "Unmapped tiles - add them to $tiles_file:\n";
    for my $u (@unknown) {
        my ($key) = $u =~ /^(\S+ tile \d+)/;
        print STDERR "  $u\n" unless $seen{$key}++;
    }
    exit 2;
}

# fold collected digit overlays into whatever needed them
for my $c (@cells) {
    my $digits = delete $c->{phases};
    next unless @$digits;
    # bollard digits are per-edge, so settle those before the rest
    for my $d (grep { ($_->{for} // '') eq 'bollard' } @$digits) {
        # A digit tile may name several edges - the sheet has one that covers
        # north and west - so only complain when NONE of them has a bollard.
        my $hit = 0;
        for my $e (@{ $d->{edges} || [] }) {
            my $edge = edge_of_kind($c, $e, 'bollard') or next;
            push @{ $edge->{phases} }, $d->{digit};
            $hit++;
        }
        warn "bollard digit $d->{digit} names edge(s) "
           . join(', ', @{ $d->{edges} || [] }) . " but no bollard is there\n"
            unless $hit;
    }
    for my $e (map { @$_ } values %{ $c->{edges} }) {
        next unless ($e->{kind} // '') eq 'bollard' && $e->{phases};
        my %s;
        $e->{phases} = [ sort { $a <=> $b } grep { !$s{$_}++ } @{ $e->{phases} } ];
    }
    $digits = [ grep { ($_->{for} // '') ne 'bollard' } @$digits ];
    next unless @$digits;

    # group the remaining digits by the element they name
    my %by;
    push @{ $by{ $_->{for} // '' } }, $_->{digit} for @$digits;
    for my $owner (keys %by) {
        my %s;
        my @p = sort { $a <=> $b } grep { !$s{$_}++ } @{ $by{$owner} };
        my $target =
              $owner eq 'crusher'     ? $c->{crusher}
            : $owner eq 'flamer'      ? $c->{flamer}
            : $owner eq 'pusher'      ? $c->{pusher}
            : $owner eq 'trapDoorPit' ? (($c->{floor}{kind} // '') eq 'trapDoorPit' ? $c->{floor} : undef)
            : undef;
        unless ($target) {
            warn sprintf("phase digits %s name owner '%s' but no such element on this cell\n",
                join(',', @p), $owner || '(unset)');
            next;
        }
        $target->{phases} = \@p;
    }
}

# terrain was collected as a set so a cell can carry more than one and repeats
# do not pile up. A cell with terrain and nothing else is terrain as ground, so
# give it an open floor to sit on.
for my $c (@cells) {
    my $t = delete $c->{terrain} or next;
    $c->{terrain} = [ sort keys %$t ];
    $c->{floor} //= { kind => 'open' };
}

# steep markers are overlays rather than a property of the ramp art, the same
# split the library uses for pusher phases. Each names the edge its ramp
# crosses, so it upgrades that edge and nothing else.
for my $i (0 .. $#cells) {
    my $c = $cells[$i];
    my $marks = delete $c->{steepMark} or next;
    my $at = sprintf 'c%dr%d', $i % $W, int($i / $W);
    for my $e (@$marks) {
        my $edge = edge_of_kind($c, $e, 'cliff');
        unless ($edge) {
            warn "steep marker at $at names edge $e but there is no cliff there\n";
            next;
        }
        unless ($edge->{ramp}) {
            warn "steep marker at $at names edge $e but that cliff has no ramp\n";
            next;
        }
        $edge->{ramp}{extraMoves} = 2;
    }
}

warn "note: tilesets referenced but not found: @{[ join ', ', $map->missing ]}\n"
    if $map->missing;

# Ridges: two adjacent cells that each independently draw their own cliff
# facing the other, both claiming the far side is high. That is mutually
# contradictory under the ordinary single-cliff model (one side has to
# actually be higher), and is how a real board draws a peak between two
# ledges - up one side, immediately back down the other, net elevation
# change zero, but still impassable in both directions without a ramp.
#
# Confirmed against real board data: TrafficJam5's Ramps/Ledges tileset
# places tile 3 on one cell and tile 6 on its neighbor specifically to draw
# this, and per this library's own convention a cliff is normally recorded
# on only ONE of its two cells - so finding it recorded on BOTH, with both
# sides claiming the other is high, is the actual signal, not a labelling
# mistake to warn about and pick one side (which is what happened before
# this pass existed, and is why a real ridge came out of the converter as
# an ordinary 1-level cliff).
#
# This does NOT fire for the case where two tiles land on the SAME cell's
# SAME edge (that is ordinary "assembled from partial pieces" art - see the
# merge logic above - and stays a single 1-level cliff, confirmed against
# real data to remain correct as-is).
my %DELTA = (N => [0, -1], S => [0, 1], E => [1, 0], W => [-1, 0]);
for my $i (0 .. $#cells) {
    my $c  = $cells[$i];
    my ($x, $y) = ($i % $W, int($i / $W));
    for my $dir (qw(N E S W)) {
        my $edge = edge_of_kind($c, $dir, 'cliff');
        next unless $edge;
        next if $edge->{ridge}; # already resolved from the other side

        my ($dx, $dy) = @{ $DELTA{$dir} };
        my ($nx, $ny) = ($x + $dx, $y + $dy);
        next if $nx < 0 || $ny < 0 || $nx >= $W || $ny >= $H;
        my $neighbor = $cells[ $ny * $W + $nx ];
        my $back = edge_of_kind($neighbor, opposite($dir), 'cliff');
        next unless $back;

        if ($edge->{drop} eq 'in' && $back->{drop} eq 'in') {
            # Both sides claim the far side is high: a ridge. Keep the
            # record on this cell only, per the one-side convention, and
            # drop the neighbor's redundant copy.
            delete $edge->{ramp};
            delete $edge->{levels};
            $edge->{ridge} = JSON::PP::true;
            @{ $neighbor->{edges}{ opposite($dir) } } =
                grep { $_ != $back } @{ $neighbor->{edges}{ opposite($dir) } };
            delete $neighbor->{edges}{ opposite($dir) }
                unless @{ $neighbor->{edges}{ opposite($dir) } };
        }
        elsif ($edge->{drop} eq $back->{drop}) {
            # Both cells drew a cliff on the same boundary, same direction
            # of drop from each own side, agreeing with each other - not a
            # ridge, just doubly-recorded. Keep one, drop the duplicate.
            @{ $neighbor->{edges}{ opposite($dir) } } =
                grep { $_ != $back } @{ $neighbor->{edges}{ opposite($dir) } };
            delete $neighbor->{edges}{ opposite($dir) }
                unless @{ $neighbor->{edges}{ opposite($dir) } };
        }
        else {
            warn sprintf
                "cliff recorded on both sides of c%dr%d/%s disagree in an ".
                "unrecognised way (drop %s vs %s) - left as-is, check by hand\n",
                $x, $y, $dir, $edge->{drop}, $back->{drop};
        }
    }
}

print JSON::PP->new->canonical->pretty->encode({
    name   => $map->name,
    width  => $W,
    height => $H,
    cells  => [ map { my $r = $_;
                      [ map { $cells[ $r * $W + $_ ] } 0 .. $W - 1 ] } 0 .. $H - 1 ],
});
