#!/usr/bin/perl
use strict;
use warnings;
use JSON::PP;
use File::Basename qw(basename);
use Getopt::Long;

# board2svg.pl [--out F] [--cell N] [--no-legend] board.json
#
# Draws a schematic of a board from its JSON alone.
#
# THE POINT OF THIS TOOL IS WHAT IT REFUSES TO READ. It never opens a tileset,
# never looks at a sprite, and has no idea what the board looks like. Every
# mark it makes is derived from a semantic field: an arrow because the JSON
# says `exit: N`, hatching because the JSON says `drop: in`.
#
# That is what makes it a check. tmx2board.pl catches tiles it has never been
# taught about; tmx2png.pl catches tiles placed but not drawn. Neither catches
# a tile drawn correctly and labelled wrongly - the config converts, the render
# matches the art perfectly, and the board plays wrong. Comparing this
# schematic against the printed board is the only way to see that.
#
# So: read this output next to the real board and look for disagreement.
# A belt pointing the wrong way, a gear turning the wrong way, a pusher on the
# wrong edge, a cliff with its high side backwards - all become visible here
# and are invisible everywhere else.
#
# Anything in the JSON this tool does not know how to draw is reported at the
# end and stamped on the cell in red, because a verification tool that silently
# omits something is worse than no tool at all.

our $ROWPITCH;                      # key mode leaves room for captions
my ($out, $CELL, $legend, $key) = (undef, 90, 1, 0);
GetOptions('out=s' => \$out, 'cell=i' => \$CELL, 'legend!' => \$legend,
           'key' => \$key) or die;

# --key builds its own board of one-element sample cells instead of reading
# one. The point is that the reference card is drawn by the SAME code that
# draws real boards, so it cannot drift out of date the way a hand-maintained
# legend would.
my @CAPTION;
my $board;
if ($key) {
    my @s = key_samples();
    my $cols = 6;
    my @cells;
    for my $i (0 .. $#s) {
        push @CAPTION, $s[$i][0];
        $cells[ int($i / $cols) ][ $i % $cols ] = $s[$i][1];
    }
    for my $row (@cells) {
        $row->[$_] //= { floor => { kind => 'open' }, edges => {}, level => 0 }
            for 0 .. $cols - 1;
    }
    $board = { name => 'board element key', width => $cols,
               height => scalar @cells, cells => \@cells };
    $out //= 'board-element-key.svg';
    $legend = 0;
}
else {
    my $file = shift(@ARGV)
        or die "usage: $0 [--out F] [--cell N] [--no-legend] board.json\n"
             . "       $0 --key [--out F]\n";
    $board = JSON::PP->new->decode(do {
        open my $fh, '<:raw', $file or die "$file: $!";
        local $/; <$fh>;
    });
}

# One cell per thing the schematic can draw. Order groups related items so the
# variants that are easiest to confuse sit next to each other.
sub key_samples {
    my $f    = sub { { floor => { kind => $_[0] // 'open' }, edges => {}, level => 0 } };
    my $with = sub { my ($k, $v) = @_; my $c = $f->(); $c->{$k} = $v; $c };
    my $edge = sub { my ($d, $spec) = @_; my $c = $f->(); $c->{edges}{$d} = $spec; $c };
    my $belt = sub { my ($en, $ex, $x) = @_;
                     $with->('conveyor', { entries => $en, exit => $ex, express => $x }) };
    return (
      ['open floor',         $f->()],
      ['pit',                $f->('pit')],
      ['trap door pit',      do { my $c = $f->('trapDoorPit');
                                  $c->{floor}{phases} = [2,4]; $c }],
      ['belt S to N',        $belt->(['S'], 'N', 0)],
      ['belt W to E',        $belt->(['W'], 'E', 0)],
      ['belt S to W',        $belt->(['S'], 'W', 0)],
      ['belt W to N',        $belt->(['W'], 'N', 0)],
      ['belt N+E to S',      $belt->(['N','E'], 'S', 0)],
      ['belt merge to N',    $belt->(['S','W','E'], 'N', 0)],
      ['express S to N',     $belt->(['S'], 'N', 1)],
      ['express W to E',     $belt->(['W'], 'E', 1)],
      ['express S to W',     $belt->(['S'], 'W', 1)],
      ['express W to N',     $belt->(['W'], 'N', 1)],
      ['express N+E to S',   $belt->(['N','E'], 'S', 1)],
      ['express merge to N', $belt->(['S','W','E'], 'N', 1)],
      ['current S to N',     do { my $c = $with->('current',
                               { entries => ['S'], exit => 'N', express => 0 });
                                  $c->{terrain} = ['water']; $c }],
      ['current W to N',     do { my $c = $with->('current',
                               { entries => ['W'], exit => 'N', express => 0 });
                                  $c->{terrain} = ['water']; $c }],
      ['current merge to N', do { my $c = $with->('current',
                               { entries => ['S','W','E'], exit => 'N', express => 0 });
                                  $c->{terrain} = ['water']; $c }],
      ['gear CW',            $with->('gear', { rotation => 'CW' })],
      ['gear CCW',           $with->('gear', { rotation => 'CCW' })],
      ['pusher N, 1 3 5',    $with->('pusher',
                               { edge => 'N', push => 'S', phases => [1,3,5] })],
      ['pusher W, 2 4',      $with->('pusher',
                               { edge => 'W', push => 'E', phases => [2,4] })],
      ['wall',               $edge->('N', { kind => 'wall' })],
      ['spiked wall',        $edge->('N', { kind => 'wall', spikes => 1 })],
      ['one-way red',        $edge->('N', { kind => 'wall', oneWay => 'red' })],
      ['one-way green',      $edge->('N', { kind => 'wall', oneWay => 'green' })],
      ['cliff, low side in', $edge->('N', { kind => 'cliff', drop => 'in' })],
      ['cliff, 2 levels',    $edge->('N', { kind => 'cliff', drop => 'in', levels => 2 })],
      ['cliff, ridge',       $edge->('N', { kind => 'cliff', ridge => 1 })],
      ['cliff + ramp',       $edge->('N', { kind => 'cliff', drop => 'in',
                                            ramp => { extraMoves => 1 } })],
      ['cliff + steep ramp', $edge->('N', { kind => 'cliff', drop => 'in',
                                            ramp => { extraMoves => 2 } })],
      ['bollard 2 3 4',      $edge->('N', { kind => 'bollard', phases => [2,3,4] })],
      ['repulsor',           $edge->('W', { kind => 'repulsor' })],
      ['laser, 1 beam',      $edge->('W', { kind => 'laser', count => 1 })],
      ['laser, 3 beams',     $edge->('W', { kind => 'laser', count => 3 })],
      ['beam crossing',      $with->('beams', [ { along => 'E', count => 3 } ])],
      ['crusher 2 4',        $with->('crusher', { phases => [2,4] })],
      ['crusher on a belt',  do { my $c = $belt->(['W'], 'E', 0);
                                  $c->{crusher} = { phases => [1,3,5] }; $c }],
      ['crusher on express', do { my $c = $belt->(['N','W'], 'E', 1);
                                  $c->{crusher} = { phases => [2,4] }; $c }],
      ['flamer 1 3',         $with->('flamer', { colour => 'orange', phases => [1,3] })],
      ['repair 1 wrench',    $with->('repair', { wrenches => 1 })],
      ['repair 2 wrenches',  $with->('repair', { wrenches => 2 })],
      ['wrench + hammer',    $with->('repair', { wrenches => 1, hammer => 1 })],
      ['generator red',      $with->('generator', { colour => 'red' })],
      ['generator green',    $with->('generator', { colour => 'green' })],
      ['portal black',       $with->('portal', { colour => 'black' })],
      ['portal lavender',    $with->('portal', { colour => 'lavender' })],
      ['stunt ramp W to E',  $with->('stuntRamp', { entry => 'W', exit => 'E' })],
      ['start position 3',   $with->('start', 3)],
      ['pit stop',           $with->('pitStop', JSON::PP::true)],
      ['chop shop',          $with->('chopShop', JSON::PP::true)],
      ['teleporter',         $with->('teleporter', JSON::PP::true)],
      ['randomizer',         $with->('randomizer', JSON::PP::true)],
      ['radiation',          $with->('radiation', JSON::PP::true)],
      ['radioactive waste',  $with->('radioactiveWaste', JSON::PP::true)],
      ['rest stop',          $with->('restStop', JSON::PP::true)],
      ['oil',                $with->('terrain', ['oil'])],
      ['gravel',             $with->('terrain', ['gravel'])],
      ['mud',                $with->('terrain', ['mud'])],
      ['sand',               $with->('terrain', ['sand'])],
      ['water',              $with->('terrain', ['water'])],
      ['slime',              $with->('terrain', ['slime'])],
      ['flaming oil',        $with->('terrain', ['flamingOil'])],
      ['spikes',             $with->('terrain', ['spikes'])],
      ['speed bump',         $with->('terrain', ['speedBump'])],
      ['smoke',              $with->('smoke', JSON::PP::true)],
      ['oil on gravel',      $with->('terrain', ['gravel','oil'])],
      ['speed bump on sand', $with->('terrain', ['sand','speedBump'])],
      ['gravel over a belt', do { my $c = $belt->(['W'], 'E', 0);
                                  $c->{terrain} = ['gravel']; $c }],
    );
}

my ($W, $H) = ($board->{width}, $board->{height});
my $NAME = $board->{name} // 'board';
$ROWPITCH = $CELL + ($key ? 26 : 0);
$out //= "$NAME-schematic.svg";

# ----------------------------------------------------------------------------
# geometry helpers. Directions are N/E/S/W as stored; y grows downward.

my $PAD  = 34;                      # room for the coordinate ruler
my $LEG  = $legend ? 190 : 0;       # legend column on the right
my ($SW, $SH) = ($PAD + $W * $CELL + $LEG + 10,
                 $PAD + $H * $ROWPITCH + 10);

sub ox { $PAD + $_[0] * $CELL }     # left edge of column
sub oy { $PAD + $_[0] * $ROWPITCH } # top edge of row

# midpoint of an edge, as a fraction of the cell box
my %EDGE_MID = (N => [0.5, 0], S => [0.5, 1], W => [0, 0.5], E => [1, 0.5]);
# unit vector pointing INTO the cell from that edge
my %INWARD   = (N => [0, 1], S => [0, -1], W => [1, 0], E => [-1, 0]);

sub edge_pt {                        # absolute point on an edge, with inset
    my ($c, $r, $dir, $inset) = @_;
    $inset //= 0;
    my ($fx, $fy) = @{ $EDGE_MID{$dir} };
    my ($ix, $iy) = @{ $INWARD{$dir} };
    return (ox($c) + $fx * $CELL + $ix * $inset,
            oy($r) + $fy * $CELL + $iy * $inset);
}

sub edge_line {                      # the two corners of an edge
    my ($c, $r, $dir) = @_;
    my ($x, $y) = (ox($c), oy($r));
    return $dir eq 'N' ? ($x, $y, $x + $CELL, $y)
         : $dir eq 'S' ? ($x, $y + $CELL, $x + $CELL, $y + $CELL)
         : $dir eq 'W' ? ($x, $y, $x, $y + $CELL)
         :               ($x + $CELL, $y, $x + $CELL, $y + $CELL);
}

sub centre { (ox($_[0]) + $CELL / 2, oy($_[1]) + $CELL / 2) }

# ----------------------------------------------------------------------------
# palette. Deliberately flat and unlike the board art - this must not be
# mistakable for a render.

my %FILL = (
    open        => '#ffffff',
    pit         => '#1b1b1b',
    trapDoorPit => '#4a4a4a',
);
# Element colours. Belts are told apart by colour as well as stroke weight,
# and gears by colour as well as arc direction, so neither relies on the
# reader spotting a single small cue.
my $CONV_PLAIN   = '#b8860b';   # single-speed conveyor (the art is yellow)
my $CONV_EXPRESS = '#1552b0';   # express conveyor
my $CURRENT      = '#0f7f8c';   # water current
my $GEAR_CW      = '#0a7d3a';   # clockwise
my $GEAR_CCW     = '#cc2222';   # counter-clockwise

# Ground splits in two.
#
# A BASE cover is the ground itself - you are standing on gravel, or in water -
# so it fills the square and everything else draws over it.
#
# An OVERLAY is something spilled or bolted onto whatever ground is already
# there. Oil can lie on gravel and a speed bump can sit in sand, so these get a
# motif and no background of their own; painting them as a fill would hide the
# terrain underneath and imply a replacement that the format does not perform.
my %BASE_FILL = (
    slime      => '#8fbf4a', gravel => '#c2b49c', mud   => '#8d7050',
    sand       => '#ecdcaa', water  => '#8fb8d8', smoke => '#b6b6bb',
    radiation        => '#c6e8a6',   # light green
    radioactiveWaste => '#4f8a2e',   # darker green
);
my %OVERLAY = map { $_ => 1 } qw(oil flamingOil spikes speedBump);

my @svg;
sub emit { push @svg, @_ }
sub esc { my $s = shift(@_) // ''; $s =~ s/&/&amp;/g; $s =~ s/</&lt;/g; $s =~ s/>/&gt;/g; $s }

# Motifs for the overlays, plus smoke, which is a base fill that still needs
# something to look at.
sub ground_motif {
    my ($kind, $x, $y) = @_;
    my ($cx, $cy) = ($x + $CELL / 2, $y + $CELL / 2);
    if ($kind eq 'spikes') {                     # a row of teeth
        for my $i (0 .. 3) {
            my $bx = $x + 20 + $i * 17;
            emit sprintf('<polygon points="%.1f,%.1f %.1f,%.1f %.1f,%.1f" '
                       . 'fill="#4a423a"/>',
                $bx, $y + $CELL - 16, $bx + 6, $y + $CELL - 5,
                $bx - 6, $y + $CELL - 5);
        }
    }
    elsif ($kind eq 'speedBump') {               # hazard roundel, no background
        emit sprintf('<circle cx="%.1f" cy="%.1f" r="15" fill="#111"/>', $cx, $cy);
        emit sprintf('<circle cx="%.1f" cy="%.1f" r="9" fill="none" '
                   . 'stroke="#f2c200" stroke-width="2.6"/>', $cx, $cy);
        emit sprintf('<circle cx="%.1f" cy="%.1f" r="3.4" fill="#f2c200"/>',
            $cx, $cy);
    }
    elsif ($kind eq 'oil' or $kind eq 'flamingOil') {
        # A spilled puddle rather than a fill, so the ground shows through.
        # Flaming oil IS oil, so it keeps the same slick and only adds flame -
        # a different puddle colour would suggest a different substance.
        my $col = '#3a3a44';
        emit sprintf('<ellipse cx="%.1f" cy="%.1f" rx="26" ry="17" fill="%s" '
                   . 'opacity="0.78"/>', $cx, $cy + 4, $col);
        emit sprintf('<ellipse cx="%.1f" cy="%.1f" rx="11" ry="8" fill="%s" '
                   . 'opacity="0.78"/>', $cx - 18, $cy - 9, $col);
        glyph_flames($cx, $cy - 6) if $kind eq 'flamingOil';
    }
    elsif ($kind eq 'smoke') {                   # drifting puffs
        for my $i (0 .. 2) {
            emit sprintf('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#8e8e97" '
                       . 'opacity="0.55"/>',
                $x + 22 + $i * 22, $y + 26 + ($i % 2) * 16, 9 - $i);
        }
    }
}

# An SVG id may not usefully contain '#', so a colour cannot be pasted into a
# marker id - url(#head-#1552b0) does not resolve and the arrowheads silently
# vanish. Strip it to hex digits.
sub mid { my $c = shift(@_); $c =~ s/[^0-9a-zA-Z]//g; return "head-$c" }

sub text {
    my ($x, $y, $s, %o) = @_;
    emit sprintf('<text x="%.1f" y="%.1f" font-size="%s" fill="%s" '
               . 'text-anchor="%s" font-family="monospace"%s>%s</text>',
        $x, $y, $o{size} // 9, $o{fill} // '#222', $o{anchor} // 'middle',
        ($o{weight} ? ' font-weight="bold"' : ''), esc($s));
}

# Draw an arrowhead at ($x,$y) pointing along ($dx,$dy).
#
# This used to be an SVG <marker> with orient="auto-start-reverse". Renderers
# disagree about that keyword, and a schematic whose arrows may be drawn
# backwards is worse than useless - it would send you off to "fix" a label
# that was already right. So the head is a plain polygon and its direction is
# arithmetic that every renderer must reproduce identically.
sub arrowhead {
    my ($x, $y, $dx, $dy, $colour, $size) = @_;
    $size //= 5;
    my $len = sqrt($dx * $dx + $dy * $dy) or return;
    ($dx, $dy) = ($dx / $len, $dy / $len);
    my ($px, $py) = (-$dy, $dx);               # perpendicular
    emit sprintf('<polygon points="%.1f,%.1f %.1f,%.1f %.1f,%.1f" fill="%s"/>',
        $x, $y,
        $x - $dx * $size * 2 + $px * $size, $y - $dy * $size * 2 + $py * $size,
        $x - $dx * $size * 2 - $px * $size, $y - $dy * $size * 2 - $py * $size,
        $colour);
}

sub line {
    my ($x1, $y1, $x2, $y2, %o) = @_;
    emit sprintf('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" '
               . 'stroke-width="%s"%s/>',
        $x1, $y1, $x2, $y2, $o{stroke} // '#222', $o{width} // 1,
        ($o{dash} ? qq{ stroke-dasharray="$o{dash}"} : ''));
    # a straight line's tangent is the line itself
    arrowhead($x2, $y2, $x2 - $x1, $y2 - $y1, $o{arrow}, $o{head})
        if $o{arrow};
}

# ----------------------------------------------------------------------------
# arrows. A conveyor is drawn entry-edge -> centre -> exit-edge with the head
# at the exit, which is the whole point: direction is readable at a glance and
# a reversed belt is obvious against the printed board.

# A current is water, so it draws as a wave rather than a straight arrow.
# Same start and end points as a belt would use, so the two are directly
# comparable where a board carries both.
sub current_path {
    my ($c, $r, $entry, $exit, $colour) = @_;
    my ($cx, $cy) = centre($c, $r);
    my ($sx, $sy) = edge_pt($c, $r, $entry, 3);
    my ($xx, $xy) = edge_pt($c, $r, $exit, 9);
    my ($PI, $N, $AMP) = (atan2(1, 1) * 4, 24, 3.6);
    my @pts;
    for my $i (0 .. $N) {
        my $t = $i / $N;
        my $u = 1 - $t;
        # point on the quadratic, then pushed sideways by a sine
        my $px = $u * $u * $sx + 2 * $u * $t * $cx + $t * $t * $xx;
        my $py = $u * $u * $sy + 2 * $u * $t * $cy + $t * $t * $xy;
        my $dx = 2 * $u * ($cx - $sx) + 2 * $t * ($xx - $cx);
        my $dy = 2 * $u * ($cy - $sy) + 2 * $t * ($xy - $cy);
        my $len = sqrt($dx * $dx + $dy * $dy) || 1;
        my $w = sin($t * 3 * $PI) * $AMP * ($t < 0.92 ? 1 : 0);
        push @pts, sprintf('%.1f,%.1f', $px - $dy / $len * $w,
                                        $py + $dx / $len * $w);
    }
    emit sprintf('<circle cx="%.1f" cy="%.1f" r="2.4" fill="%s"/>',
        $sx, $sy, $colour);
    emit sprintf('<polyline points="%s" fill="none" stroke="%s" '
               . 'stroke-width="1.9"/>', join(' ', @pts), $colour);
    arrowhead($xx, $xy, $xx - $cx, $xy - $cy, $colour, 5);
}

sub belt_path {
    my ($c, $r, $entry, $exit, $express, $colour) = @_;
    my ($cx, $cy) = centre($c, $r);

    # An express belt is drawn as TWO parallel arrows straddling the line a
    # single belt would take, so the pair is the signal rather than a
    # difference in stroke weight that only shows up in comparison.
    my ($einx, $einy)  = @{ $INWARD{$entry} };          # heading at the start
    my ($eoutx, $eouty) = map { -$_ } @{ $INWARD{$exit} };  # heading at the end
    my @offsets = $express ? (-4.5, 4.5) : (0);

    for my $k (@offsets) {
        # perpendicular offset at each end, so both strands stay parallel to
        # the path even where it turns a corner
        my ($sx, $sy) = edge_pt($c, $r, $entry, 3);
        my ($xx, $xy) = edge_pt($c, $r, $exit, 9);
        $sx += -$einy  * $k; $sy += $einx  * $k;
        $xx += -$eouty * $k; $xy += $eoutx * $k;
        my $qx = $cx + (-$einy + -$eouty) / 2 * $k;
        my $qy = $cy + ( $einx +  $eoutx) / 2 * $k;

        emit sprintf('<circle cx="%.1f" cy="%.1f" r="2.4" fill="%s"/>',
            $sx, $sy, $colour);
        emit sprintf('<path d="M %.1f %.1f Q %.1f %.1f %.1f %.1f" fill="none" '
                   . 'stroke="%s" stroke-width="1.8"/>',
            $sx, $sy, $qx, $qy, $xx, $xy, $colour);
        # for a quadratic Bezier the tangent at the end point is end - control
        arrowhead($xx, $xy, $xx - $qx, $xy - $qy, $colour, 5);
    }
}

# A cliff is the one asymmetric edge in the format, and the one most likely to
# be recorded backwards. `drop: in` means the cell that owns the edge is the
# LOW side, so the hatching goes inside that cell: ticks hang off the edge into
# the low ground, the way a map draws an escarpment.
#
# Two variants, both added this session, both need to look UNMISTAKABLY
# different from the ordinary case rather than just annotated, per this
# file's own founding principle (see "Drawn glyphs" below): a ridge has no
# low side at all, so drawing the ordinary one-directional hatch on it would
# actively lie about which side falls. And a multi-level cliff still has a
# low side, but a hatch identical to a plain 1-level drop would hide the one
# fact - how far - that most needs to survive the trip from data to eyeball.
sub cliff_edge {
    my ($c, $r, $dir, $spec) = @_;
    my ($x1, $y1, $x2, $y2) = edge_line($c, $r, $dir);
    my ($ix, $iy) = @{ $INWARD{$dir} };
    ($x1, $y1, $x2, $y2) = ($x1 + $ix * 1.7, $y1 + $iy * 1.7,
                            $x2 + $ix * 1.7, $y2 + $iy * 1.7);
    line($x1, $y1, $x2, $y2, stroke => '#000', width => 3.4);

    if ($spec->{ridge}) {
        # No low side to hatch into - both sides climb to reach this edge.
        # Drawn as a zigzag straddling the line itself, symmetric across it,
        # so it cannot be mistaken for "this side is low" the way a
        # one-directional hatch would claim.
        my $n = 5;
        for my $i (0 .. $n) {
            my $t  = $i / $n;
            my $bx = $x1 + ($x2 - $x1) * $t;
            my $by = $y1 + ($y2 - $y1) * $t;
            my $s  = ($i % 2) ? 1 : -1;
            line($bx, $by, $bx + $ix * 7 * $s, $by + $iy * 7 * $s,
                 stroke => '#000', width => 1.8);
        }
        return;
    }

    ($ix, $iy) = (-$ix, -$iy) if ($spec->{drop} // 'in') eq 'out';
    my $n      = 5;
    my $levels = $spec->{levels} // 1;
    for my $i (1 .. $n) {
        my $t  = $i / ($n + 1);
        my $bx = $x1 + ($x2 - $x1) * $t;
        my $by = $y1 + ($y2 - $y1) * $t;
        # A plain cliff's tick is one line, 8 units deep. Each level beyond
        # the first adds another tick immediately behind the first, same
        # spacing as the steep-ramp caret convention below - depth reads as
        # "how far", not just "down".
        for my $lvl (0 .. $levels - 1) {
            line($bx + $ix * 9 * $lvl, $by + $iy * 9 * $lvl,
                 $bx + $ix * (8 + 9 * $lvl), $by + $iy * (8 + 9 * $lvl),
                 stroke => '#000', width => 1.4);
        }
    }
    # A ramp crosses the edge, so draw a caret whose apex points UPHILL, away
    # from the low side. A steep ramp gets a second caret behind the first.
    # Steepness lives in ramp.extraMoves (2 = steep), never a top-level
    # `steep` key - real converted board.json data has never had that field
    # at this level. Confirmed as a real bug this session: it went unnoticed
    # because the synthetic key-card entry below happened to construct the
    # unrealistic shape this code was actually checking for.
    if ($spec->{ramp}) {
        my ($mx, $my) = (($x1 + $x2) / 2, ($y1 + $y2) / 2);
        my $reps = ($spec->{ramp}{extraMoves} // 1) >= 2 ? 2 : 1;
        for my $k (0 .. $reps - 1) {
            # apex points INTO the cell, away from the cliff edge, and the
            # whole caret sits inside the square - drawn on the edge it spills
            # into the neighbour and reads as belonging to the wrong one
            caret($mx + $ix * (19 + $k * 9), $my + $iy * (19 + $k * 9),
                  $ix, $iy, 8, '#0a7d3a', 2.2);
        }
    }
}

# ----------------------------------------------------------------------------
# Drawn glyphs.
#
# Anything a player has to recognise instantly gets a shape, not a caption.
# "W+H" in 7pt is unreadable at board scale and, worse, indistinguishable from
# "W2" at a glance - which is exactly the pair that was mislabelled on 05A
# tile 10 and went undetected for three sessions. A wrench and a wrench
# crossed with a hammer cannot be confused.

sub rot_open { my ($deg, $x, $y) = @_;
    emit sprintf('<g transform="rotate(%.1f %.1f %.1f)">', $deg, $x, $y) }
sub rot_close { emit '</g>' }

# A caret: apex at ($x,$y), arms trailing back along -($dx,$dy). Used for
# ramps, where the apex points the way a robot travels up or over.
sub caret {
    my ($x, $y, $dx, $dy, $size, $col, $w) = @_;
    my $len = sqrt($dx * $dx + $dy * $dy) or return;
    ($dx, $dy) = ($dx / $len, $dy / $len);
    my ($px, $py) = (-$dy, $dx);
    emit sprintf('<polyline points="%.1f,%.1f %.1f,%.1f %.1f,%.1f" fill="none" '
               . 'stroke="%s" stroke-width="%s" stroke-linecap="round" '
               . 'stroke-linejoin="round"/>',
        $x - $dx * $size + $px * $size, $y - $dy * $size + $py * $size,
        $x, $y,
        $x - $dx * $size - $px * $size, $y - $dy * $size - $py * $size,
        $col, $w // 2.2);
}

# A combination spanner: ring at one end, open jaw at the other.
sub glyph_wrench {
    my ($x, $y, $deg, $len, $col) = @_;
    rot_open($deg, $x, $y);
    my ($a, $b) = ($x - $len / 2, $x + $len / 2);
    emit sprintf('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" '
               . 'stroke-width="2.3" stroke-linecap="round"/>', $a, $y, $b, $y, $col);
    emit sprintf('<circle cx="%.1f" cy="%.1f" r="2.9" fill="none" stroke="%s" '
               . 'stroke-width="1.9"/>', $b, $y, $col);
    # open jaw, two prongs and a back
    emit sprintf('<path d="M %.1f %.1f L %.1f %.1f M %.1f %.1f L %.1f %.1f '
               . 'M %.1f %.1f L %.1f %.1f" stroke="%s" stroke-width="1.8" '
               . 'fill="none"/>',
        $a, $y - 3.1, $a - 3.4, $y - 3.1,
        $a, $y + 3.1, $a - 3.4, $y + 3.1,
        $a, $y - 3.1, $a, $y + 3.1, $col);
    rot_close();
}

# A claw hammer: handle plus a solid head.
sub glyph_hammer {
    my ($x, $y, $deg, $len, $col) = @_;
    rot_open($deg, $x, $y);
    my ($a, $b) = ($x - $len / 2, $x + $len / 2);
    emit sprintf('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" '
               . 'stroke-width="2.3" stroke-linecap="round"/>', $a, $y, $b, $y, $col);
    emit sprintf('<rect x="%.1f" y="%.1f" width="4.6" height="10.5" rx="1.2" '
               . 'fill="%s"/>', $b - 2.3, $y - 5.25, $col);
    rot_close();
}

# Repair sites, told apart by what is drawn rather than by a caption.
sub glyph_repair {
    my ($x, $y, $rp) = @_;
    my $col = '#0a7d3a';
    # Angles are 180 degrees round from the obvious reading so the working
    # ends - ring, jaw, hammer head - sit at the TOP of the cross, matching
    # the way the tile art draws them. The comparison against the printed
    # board is easier when the schematic keeps the same orientation.
    if ($rp->{hammer}) {                    # wrench AND hammer, crossed
        glyph_wrench($x, $y, 145, 17, $col);
        glyph_hammer($x, $y, 215, 15, $col);
    }
    elsif (($rp->{wrenches} // 1) >= 2) {   # two wrenches, crossed
        glyph_wrench($x, $y, 58,  17, $col);
        glyph_wrench($x, $y, 122, 17, $col);
    }
    else {                                  # one wrench
        glyph_wrench($x, $y, 135, 18, $col);
    }
}

# A lightning bolt. Shared, so a generator and a randomizer are the same mark
# at different sizes - one ringed, one not.
sub glyph_bolt {
    my ($x, $y, $scale, $col) = @_;
    my @p = ([1.4,-6.6],[-3.6,0.6],[-0.4,0.6],[-1.8,6.6],[3.6,-0.9],[0.3,-0.9]);
    emit sprintf('<polygon points="%s" fill="%s"/>',
        join(' ', map { sprintf('%.1f,%.1f', $x + $_->[0] * $scale,
                                             $y + $_->[1] * $scale) } @p), $col);
}

# A generator pays out energy, so: a bolt in a ring. Colour comes from the tile.
sub glyph_generator {
    my ($x, $y, $gn) = @_;
    my $c = ref $gn ? ($gn->{colour} // '') : '';
    my $col = $c eq 'green' ? '#16a34a' : $c eq 'red' ? '#dc2626' : '#0891b2';
    emit sprintf('<circle cx="%.1f" cy="%.1f" r="8.6" fill="none" stroke="%s" '
               . 'stroke-width="1.6"/>', $x, $y, $col);
    glyph_bolt($x, $y, 1, $col);
}

# Three flames. Used by flaming oil and by the flame thrower, which is the
# same fire arriving from a different direction.
sub glyph_flames {
    my ($x, $y) = @_;
    for my $i (0 .. 2) {
        my $fx = $x - 15 + $i * 15;
        emit sprintf('<polygon points="%.1f,%.1f %.1f,%.1f %.1f,%.1f" '
                   . 'fill="#f5a524"/>',
            $fx, $y - 14, $fx - 5, $y, $fx + 5, $y);
    }
}

# Pliers. A pit stop and a rest stop are repair sites too, so they belong in
# the same badge row as the wrenches rather than off in a caption.
sub glyph_pliers {
    my ($x, $y, $col) = @_;
    $col //= '#0a7d3a';
    rot_open(-20, $x, $y);
    for my $sgn (-1, 1) {
        emit sprintf('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" '
                   . 'fill="none" stroke="%s" stroke-width="2.1" '
                   . 'stroke-linecap="round" stroke-linejoin="round"/>',
            $x + $sgn * 5.4, $y + 9.5,     # handle end
            $x + $sgn * 1.6, $y + 0.5,     # pivot
            $x - $sgn * 2.4, $y - 9.0,     # jaw tip, crossed over
            $col);
    }
    emit sprintf('<circle cx="%.1f" cy="%.1f" r="1.9" fill="%s"/>',
        $x, $y + 0.5, $col);
    rot_close();
}

# A screwdriver, for the rest stop. Distinct in silhouette from the pliers -
# one solid handle and a straight shaft against two crossed arms - so the two
# stops are told apart by shape rather than by colour.
sub glyph_screwdriver {
    my ($x, $y, $col) = @_;
    $col //= '#0f766e';
    rot_open(-22, $x, $y);
    emit sprintf('<rect x="%.1f" y="%.1f" width="7.6" height="11" rx="3.2" '
               . 'fill="%s"/>', $x - 3.8, $y - 0.5, $col);          # handle
    emit sprintf('<rect x="%.1f" y="%.1f" width="2.6" height="9" fill="%s"/>',
        $x - 1.3, $y - 9, $col);                                    # shaft
    rot_close();
}

# A chop shop repairs and re-arms, so it belongs with the wrenches. A blowtorch
# reads as workshop without being another spanner.
sub glyph_torch {
    my ($x, $y) = @_;
    my $col = '#0a7d3a';
    rot_open(-30, $x, $y);
    emit sprintf('<rect x="%.1f" y="%.1f" width="5.6" height="12" rx="1.6" '
               . 'fill="%s"/>', $x - 2.8, $y - 1, $col);              # tank
    emit sprintf('<rect x="%.1f" y="%.1f" width="3.2" height="5" '
               . 'fill="%s"/>', $x - 1.6, $y - 5.4, $col);            # neck
    emit sprintf('<polygon points="%.1f,%.1f %.1f,%.1f %.1f,%.1f" fill="%s"/>',
        $x, $y - 14.5, $x - 3.6, $y - 5.6, $x + 3.6, $y - 5.6, '#dc6a1e');  # flame
    rot_close();
}

my (%unrendered, %seen_kind);

sub phases_label { my $p = shift(@_); ref $p && @$p ? join('', @$p) : '' }

sub draw_cell {
    my ($c, $r, $cell) = @_;
    my ($x, $y)   = (ox($c), oy($r));
    my ($cx, $cy) = centre($c, $r);
    my %todo = map { $_ => 1 } keys %$cell;
    delete @todo{qw(floor edges level terrain)};

    # --- floor plate -------------------------------------------------------
    my $fk = ($cell->{floor} || {})->{kind} // 'open';
    $seen_kind{"floor:$fk"}++;
    emit sprintf('<rect x="%.1f" y="%.1f" width="%d" height="%d" fill="%s" '
               . 'stroke="#c9c9c9" stroke-width="0.7"/>',
        $x, $y, $CELL, $CELL, $FILL{$fk} // '#ffe0e0');
    if ($fk eq 'pit' or $fk eq 'trapDoorPit') {
        text($cx, $cy + 3, $fk eq 'pit' ? 'PIT' : 'TRAP',
             size => 9, fill => '#fff', weight => 1);
        my $ph = phases_label(($cell->{floor} || {})->{phases});
        text($cx, $cy + 14, $ph, size => 8, fill => '#ffd', weight => 1) if $ph;
    }

    # --- ground cover fills the square; devices draw over it ---------------
    # Terrain does not replace the floor in this format, and it should not
    # replace it visually either - it is the ground a robot stands on, so it
    # covers the cell and everything else sits on top.
    my @ground = @{ $cell->{terrain} || [] };
    for my $flag (qw(radiation radioactiveWaste smoke)) {
        next unless $cell->{$flag};
        delete $todo{$flag};
        push @ground, $flag;
    }
    my @base    = grep { !$OVERLAY{$_} } @ground;
    my @overlay = grep {  $OVERLAY{$_} } @ground;
    $seen_kind{$_}++ for @ground;
    if (@base) {
        my $n = @base;
        for my $i (0 .. $n - 1) {
            emit sprintf('<rect x="%.1f" y="%.1f" width="%.1f" height="%d" '
                       . 'fill="%s" opacity="0.9"/>',
                $x + 1 + $i * ($CELL - 2) / $n, $y + 1, ($CELL - 2) / $n,
                $CELL - 2, $BASE_FILL{ $base[$i] } // '#ff00ff');
        }
    }
    ground_motif($_, $x, $y) for @base, @overlay;

    # --- elevation ---------------------------------------------------------
    text($x + 3, $y + $CELL - 3, "L$cell->{level}", size => 7, fill => '#888',
         anchor => 'start') if ($cell->{level} // 0) != 0;

    # --- conveyors and currents -------------------------------------------
    for my $key (qw(conveyor current)) {
        my $b = $cell->{$key} or next;
        delete $todo{$key}; $seen_kind{$key}++;
        # single-speed and express belts differ in colour, not just weight
        my $col = $key eq 'current' ? $CURRENT
                : $b->{express}     ? $CONV_EXPRESS
                :                     $CONV_PLAIN;
        my @entries = @{ $b->{entries} || [] };
        @entries = () unless @entries;
        if ($key eq 'current') {
            current_path($c, $r, $_, $b->{exit}, $col) for @entries;
        }
        else {
            belt_path($c, $r, $_, $b->{exit}, $b->{express}, $col) for @entries;
        }
        # a belt with no recorded entry still has a direction worth seeing
        unless (@entries) {
            my ($xx, $xy) = edge_pt($c, $r, $b->{exit}, 9);
            line($cx, $cy, $xx, $xy, stroke => $col, width => 1.8,
                 arrow => $col);
        }
    }

    # --- gear --------------------------------------------------------------
    if (my $g = $cell->{gear}) {
        delete $todo{gear}; $seen_kind{gear}++;
        my $cw   = ($g->{rotation} // '') eq 'CW';
        my $gcol = $cw ? $GEAR_CW : $GEAR_CCW;
        my $rad  = $CELL * 0.24;

        # A near-complete ring centred on the cell, with a small gap at the
        # top where the arrowhead sits. Drawing a partial arc instead leaves
        # the shape visually lopsided even though every point is the same
        # distance from the centre, so the gear reads as off-centre.
        my $PI  = atan2(1, 1) * 4;
        my $gap = 26;                                  # half the gap, degrees
        my ($a0, $a1) = $cw ? (-90 + $gap, -90 - $gap)
                            : (-90 - $gap, -90 + $gap);
        my ($sx, $sy) = ($cx + $rad * cos($a0 * $PI / 180),
                         $cy + $rad * sin($a0 * $PI / 180));
        my ($ex, $ey) = ($cx + $rad * cos($a1 * $PI / 180),
                         $cy + $rad * sin($a1 * $PI / 180));
        # large-arc so it takes the long way round, sweep gives the direction
        emit sprintf('<path d="M %.1f %.1f A %.1f %.1f 0 1 %d %.1f %.1f" '
                   . 'fill="none" stroke="%s" stroke-width="2.4"/>',
            $sx, $sy, $rad, $rad, $cw ? 1 : 0, $ex, $ey, $gcol);

        # circular motion: tangent is the radius turned 90 degrees, and which
        # way it turns is exactly what CW versus CCW means
        my ($rx, $ry) = ($ex - $cx, $ey - $cy);
        arrowhead($ex, $ey, $cw ? -$ry : $ry, $cw ? $rx : -$rx, $gcol, 5);
        text($cx, $cy + 3.5, $cw ? 'CW' : 'CCW', size => 7.5, fill => $gcol,
             weight => 1);
    }

    # --- pusher: arrow from its edge, pointing the way it shoves -----------
    if (my $p = $cell->{pusher}) {
        delete $todo{pusher}; $seen_kind{pusher}++;
        my $edge = $p->{edge};
        my ($ix, $iy) = @{ $INWARD{$edge} };     # into the cell = push direction
        my ($px, $py) = (-$iy, $ix);             # along the edge
        my ($mx, $my) = edge_pt($c, $r, $edge, 0);

        # The plate: a slab bolted flush to the wall it is mounted on. This is
        # deliberately unlike anything else on the schematic - a pusher is not
        # a belt and should not read as one.
        my $half = $CELL * 0.28;
        my $th   = 11;
        emit sprintf('<polygon points="%.1f,%.1f %.1f,%.1f %.1f,%.1f %.1f,%.1f" '
                   . 'fill="#c2410c"/>',
            $mx + $px * $half,            $my + $py * $half,
            $mx - $px * $half,            $my - $py * $half,
            $mx - $px * $half + $ix * $th, $my - $py * $half + $iy * $th,
            $mx + $px * $half + $ix * $th, $my + $py * $half + $iy * $th);

        # The rod and head: which way it shoves, always away from the wall
        my ($r0x, $r0y) = ($mx + $ix * $th,                $my + $iy * $th);
        my ($r1x, $r1y) = ($mx + $ix * ($th + $CELL * 0.26),
                           $my + $iy * ($th + $CELL * 0.26));
        line($r0x, $r0y, $r1x, $r1y, stroke => '#c2410c', width => 4.5);
        arrowhead($r1x, $r1y, $ix, $iy, '#c2410c', 7);

        # Registers, burned into the plate rather than floating beside it.
        # On a left or right wall the plate is vertical, so the text turns
        # with it.
        my $ph = phases_label($p->{phases}) || '-';
        my ($tx, $ty) = ($mx + $ix * ($th * 0.62), $my + $iy * ($th * 0.62));
        my $rot = ($edge eq 'W' || $edge eq 'E') ? -90 : 0;
        emit sprintf('<g transform="rotate(%d %.1f %.1f)">', $rot, $tx, $ty);
        text($tx, $ty + 3, $ph, size => 8, fill => '#fff', weight => 1);
        emit '</g>';
    }

    # --- timed devices in the centre --------------------------------------
    my @stack;
    if (my $cr = $cell->{crusher}) {
        delete $todo{crusher}; $seen_kind{crusher}++;
        emit sprintf('<circle cx="%.1f" cy="%.1f" r="15" fill="none" '
                   . 'stroke="#111" stroke-width="2.4"/>', $cx, $cy);
        my $ph = phases_label($cr->{phases});
        text($cx, $cy + 4, $ph, size => 10, fill => '#111', weight => 1) if $ph;
    }
    if (my $fl = $cell->{flamer}) {
        delete $todo{flamer}; $seen_kind{flamer}++;
        glyph_flames($cx, $cy + 2);
        my $ph = phases_label($fl->{phases});
        text($cx, $cy + 15, $ph, size => 9, fill => '#b45309', weight => 1)
            if $ph;
    }
    if (my $po = $cell->{portal}) {
        delete $todo{portal}; $seen_kind{portal}++;
        # Every colour in tiles.yml needs an entry. A portal's colour IS its
        # meaning - it is the only thing that says which two squares pair - so
        # a missing entry must not quietly become some other colour. It draws
        # grey with '??' instead, which is visibly wrong rather than plausibly
        # right. Each swatch also carries a two-letter code, because purple and
        # lavender, or red and darkred, are not tellable apart by eye at this
        # size and a mispaired portal is exactly what this drawing is for.
        my %pc = (
            black   => ['#141414', '#fff', 'BK'],
            blue    => ['#1552b0', '#fff', 'BL'],
            darkred => ['#7f1d1d', '#fff', 'DR'],
            teal    => ['#0d9488', '#fff', 'TE'],
            green   => ['#16a34a', '#fff', 'GR'],
            silver  => ['#cbd5e1', '#111', 'SI'],
            orange  => ['#ea580c', '#fff', 'OR'],
            magenta => ['#db2777', '#fff', 'MA'],
            purple  => ['#7c3aed', '#fff', 'PU'],
            red     => ['#dc2626', '#fff', 'RD'],
            yellow  => ['#eab308', '#111', 'YE'],
            lavender=> ['#c4b5fd', '#111', 'LA'],
        );
        my $name = $po->{colour} // '';
        my ($col, $ink, $code) = @{ $pc{$name} // ['#94a3b8', '#111', '??'] };
        warn "portal colour '$name' has no swatch in board2svg.pl\n"
            unless $pc{$name};
        emit sprintf('<rect x="%.1f" y="%.1f" width="30" height="30" rx="3" '
                   . 'fill="%s" stroke="#111" stroke-width="1.4"/>',
            $cx - 15, $cy - 15, $col);
        text($cx, $cy + 6, $code, size => 14, fill => $ink, weight => 1);
    }
    if (my $sr = $cell->{stuntRamp}) {
        delete $todo{stuntRamp}; $seen_kind{stuntRamp}++;
        # travel runs from the entry edge toward the exit edge
        my ($ax, $ay) = map { -$_ } @{ $INWARD{ $sr->{entry} } };
        for my $k (0 .. 2) {
            caret($cx + $ax * (14 - $k * 11), $cy + $ay * (14 - $k * 11),
                  $ax, $ay, 9, '#cc2222', 2.6);
        }
    }
    if ($cell->{randomizer}) {
        delete $todo{randomizer}; $seen_kind{randomizer}++;
        glyph_bolt($cx, $cy, 1.9, '#334155');
    }
    if ($cell->{teleporter}) {
        delete $todo{teleporter}; $seen_kind{teleporter}++;
        emit sprintf('<circle cx="%.1f" cy="%.1f" r="15" fill="#dc2626"/>',
            $cx, $cy);
        text($cx, $cy + 7, 'T', size => 21, fill => '#fff', weight => 1);
    }
    if (defined(my $st = $cell->{start})) {
        delete $todo{start}; $seen_kind{start}++;
        emit sprintf('<circle cx="%.1f" cy="%.1f" r="16" fill="#b8bcc2" '
                   . 'stroke="#5c6168" stroke-width="1.6"/>', $cx, $cy);
        text($cx, $cy + 6, $st, size => 17, fill => '#22262b', weight => 1);
    }
    if (my $bm = $cell->{beams}) {
        delete $todo{beams}; $seen_kind{beams}++;
        # one line per beam, drawn exactly like a laser's beams so the two
        # match up across a cell boundary. No end markers: a beam is passing
        # through, it does not start or stop here.
        for my $b (@$bm) {
            my ($ix, $iy) = @{ $INWARD{ $b->{along} } };
            my ($px, $py) = (-$iy, $ix);
            my $n = $b->{count} || 1;
            for my $i (0 .. $n - 1) {
                my $o = ($i - ($n - 1) / 2) * 7;
                my ($x1, $y1) = edge_pt($c, $r, $b->{along}, 0);
                my ($x2, $y2) = edge_pt($c, $r, opp($b->{along}), 0);
                line($x1 + $px * $o, $y1 + $py * $o,
                     $x2 + $px * $o, $y2 + $py * $o,
                     stroke => '#dc2626', width => 1.3);
            }
        }
    }

    my $i = 0;
    for my $s (@stack) {
        text($cx, $cy + 26 + $i * 9, $s->[0], size => 7.5, fill => $s->[1],
             weight => 1);
        $i++;
    }

    # Drawn glyphs sit in a row along the bottom-left, clear of the belt lines
    # that run edge to edge through the centre. Each gets a pale disc behind it
    # so it stays readable where it overlaps something else.
    my @badges;
    if (my $rp = $cell->{repair}) {
        delete $todo{repair}; $seen_kind{repair}++;
        push @badges, sub { glyph_repair($_[0], $_[1], $rp) };
    }
    if (my $gn = $cell->{generator}) {
        delete $todo{generator}; $seen_kind{generator}++;
        push @badges, sub { glyph_generator($_[0], $_[1], $gn) };
    }
    if ($cell->{chopShop}) {
        delete $todo{chopShop}; $seen_kind{chopShop}++;
        push @badges, sub { glyph_torch($_[0], $_[1]) };
    }
    if ($cell->{pitStop}) {
        delete $todo{pitStop}; $seen_kind{pitStop}++;
        push @badges, sub { glyph_pliers($_[0], $_[1], '#0a7d3a') };
    }
    if ($cell->{restStop}) {
        delete $todo{restStop}; $seen_kind{restStop}++;
        push @badges, sub { glyph_screwdriver($_[0], $_[1], '#0f766e') };
    }
    my $bi = 0;
    for my $draw (@badges) {
        my ($bx, $by) = ($x + 14 + $bi * 23, $y + $CELL - 14);
        emit sprintf('<circle cx="%.1f" cy="%.1f" r="11" fill="#fafaf8" '
                   . 'opacity="0.92"/>', $bx, $by);
        $draw->($bx, $by);
        $bi++;
    }

    # --- edges -------------------------------------------------------------
    # An edge carries a LIST of elements: a laser is mounted on a wall, a
    # bollard can share an edge with a cliff. Draw every one of them.
    for my $dir (sort keys %{ $cell->{edges} || {} }) {
      my $specs = $cell->{edges}{$dir};
      $specs = [$specs] if ref $specs eq 'HASH';   # tolerate the old format
      for my $spec (@$specs) {
        my $k = $spec->{kind} // '?';
        $seen_kind{"edge:$k"}++;
        my ($x1, $y1, $x2, $y2) = edge_line($c, $r, $dir);
        if ($k eq 'cliff') { cliff_edge($c, $r, $dir, $spec) }
        elsif ($k eq 'wall') {
            # A wall is recorded ON A CELL, not on the boundary between two.
            # Drawn centred on the line it straddles the join, so you cannot
            # tell which side owns it, and on the perimeter it hangs off the
            # board entirely. Inset by half its width so it lies wholly inside
            # the cell that carries it.
            my ($wix, $wiy) = @{ $INWARD{$dir} };
            ($x1, $y1, $x2, $y2) = ($x1 + $wix * 2, $y1 + $wiy * 2,
                                    $x2 + $wix * 2, $y2 + $wiy * 2);
            line($x1, $y1, $x2, $y2, stroke => '#111', width => 4);
            if ($spec->{spikes}) {
                my ($ix, $iy) = @{ $INWARD{$dir} };
                for my $t (0.18, 0.36, 0.54, 0.72, 0.9) {
                    my $bx = $x1 + ($x2 - $x1) * $t;
                    my $by = $y1 + ($y2 - $y1) * $t;
                    line($bx, $by, $bx + $ix * 15, $by + $iy * 15,
                         stroke => '#dc2626', width => 1.9);
                }
            }
            if (my $ow = $spec->{oneWay}) {
                my ($mx, $my) = (($x1 + $x2) / 2, ($y1 + $y2) / 2);
                my ($ix, $iy) = @{ $INWARD{$dir} };
                emit sprintf('<circle cx="%.1f" cy="%.1f" r="3.6" fill="%s" '
                           . 'stroke="#111" stroke-width="0.8"/>',
                    $mx + $ix * 6, $my + $iy * 6,
                    $ow eq 'green' ? '#16a34a' : '#dc2626');
            }
        }
        elsif ($k eq 'repulsor') {
            # an edge feature owned by a cell, so inset like the wall family
            my ($ix, $iy) = @{ $INWARD{$dir} };
            ($x1, $y1, $x2, $y2) = ($x1 + $ix * 1.5, $y1 + $iy * 1.5,
                                    $x2 + $ix * 1.5, $y2 + $iy * 1.5);
            line($x1, $y1, $x2, $y2, stroke => '#7c3aed', width => 3,
                 dash => '2 3');
            my ($mx, $my) = (($x1 + $x2) / 2, ($y1 + $y2) / 2);
            line($mx + $ix * 4, $my + $iy * 4, $mx + $ix * 13, $my + $iy * 13,
                 stroke => '#7c3aed', width => 1.6, arrow => '#7c3aed', head => 4);
        }
        elsif ($k eq 'bollard') {
            # a bollard is a timed wall, so it belongs inside its own cell too
            my ($ix, $iy) = @{ $INWARD{$dir} };
            ($x1, $y1, $x2, $y2) = ($x1 + $ix * 2.2, $y1 + $iy * 2.2,
                                    $x2 + $ix * 2.2, $y2 + $iy * 2.2);
            # hazard striping: yellow laid down first, black dashes over it
            line($x1, $y1, $x2, $y2, stroke => '#f2c200', width => 4.4);
            line($x1, $y1, $x2, $y2, stroke => '#111', width => 4.4,
                 dash => '6 6');
            my ($mx, $my) = (($x1 + $x2) / 2, ($y1 + $y2) / 2);
            text($mx + $ix * 10, $my + $iy * 10 + 3,
                 phases_label($spec->{phases}) || 'B',
                 size => 7, fill => '#a16207', weight => 1);
        }
        elsif ($k eq 'laser') {
            # One emitter and one line per beam, so the count is countable
            # rather than written down beside a single line.
            #
            # The emitter sits WELL inside the cell it belongs to. Drawn on the
            # boundary it reads as belonging to the neighbour - a north-edge
            # emitter looks like it is in the row above - and where a wall,
            # cliff or bollard shares the edge it vanishes under the bar. Those
            # occupy the first 4px inward, so start beyond them.
            my ($ix, $iy) = @{ $INWARD{$dir} };
            my ($mx, $my) = (($x1 + $x2) / 2 + $ix * 16,
                             ($y1 + $y2) / 2 + $iy * 16);
            my ($px, $py) = (-$iy, $ix);           # along the edge
            my $n = $spec->{count} || 1;
            for my $i (0 .. $n - 1) {
                my $o = ($i - ($n - 1) / 2) * 7;
                my ($bx, $by) = ($mx + $px * $o, $my + $py * $o);
                emit sprintf('<circle cx="%.1f" cy="%.1f" r="3.2" '
                           . 'fill="#dc2626"/>', $bx, $by);
                line($bx, $by, $bx + $ix * ($CELL - 22), $by + $iy * ($CELL - 22),
                     stroke => '#dc2626', width => 1.3);
            }
        }
        else {
            line($x1, $y1, $x2, $y2, stroke => '#ff00ff', width => 4);
            $unrendered{"edge:$k"}++;
        }
      }
    }

    # --- anything this tool does not know how to draw ----------------------
    if (my @left = sort keys %todo) {
        $unrendered{$_}++ for @left;
        emit sprintf('<rect x="%.1f" y="%.1f" width="%d" height="%d" '
                   . 'fill="none" stroke="#ff00ff" stroke-width="2"/>',
            $x + 1, $y + 1, $CELL - 2, $CELL - 2);
        text($cx, $y + $CELL - 6, '?' . join(',', @left), size => 7,
             fill => '#ff00ff', weight => 1);
    }
}

sub opp { my %o = (N => 'S', S => 'N', E => 'W', W => 'E'); $o{ $_[0] // '' } // 'S' }

# ----------------------------------------------------------------------------
emit sprintf('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
           . 'font-family="monospace">', $SW, $SH);
emit sprintf('<rect width="100%%" height="100%%" fill="#fafaf8"/>');
text($PAD, 18, $key
     ? 'RoboRally board element key - every mark below is drawn by the same '
       . 'code that draws a real board'
     : "$NAME - schematic from board.json, no tileset art",
     size => 13, anchor => 'start', weight => 1);

# coordinate ruler
unless ($key) {
    for my $c (0 .. $W - 1) {
        text(ox($c) + $CELL / 2, $PAD - 6, "c$c", size => 8, fill => '#666');
    }
    for my $r (0 .. $H - 1) {
        text($PAD - 6, oy($r) + $CELL / 2 + 3, "r$r", size => 8, fill => '#666',
             anchor => 'end');
    }
}

for my $r (0 .. $H - 1) {
    for my $c (0 .. $W - 1) {
        draw_cell($c, $r, $board->{cells}[$r][$c] || {});
    }
}

if ($key) {
    for my $i (0 .. $#CAPTION) {
        my ($c, $r) = ($i % $W, int($i / $W));
        text(ox($c) + $CELL / 2, oy($r) + $CELL + 15, $CAPTION[$i],
             size => 8.5, fill => '#222');
    }
}

if ($legend) {
    my $lx = $PAD + $W * $CELL + 12;
    my $ly = $PAD + 4;
    text($lx, $ly, 'READING THIS', size => 10, anchor => 'start', weight => 1);
    my @notes = (
        ['dot -> head',   'belt runs FROM the dot TO the head'],
        ['red arrow',     'single-speed conveyor'],
        ['two blue',      'express conveyor (parallel pair)'],
        ['teal arrow',    'water current'],
        ['green arc',     'gear turns clockwise'],
        ['red arc',       'gear turns counter-clockwise'],
        ['orange plate',  'pusher: plate on its wall, rod shows'],
        ['  + rod',       'the shove, digits are its registers'],
        ['black bar',     'wall'],
        ['bar + ticks',   'cliff; ticks hang into the LOW side'],
        ['  2+ ticks deep', 'that many levels of drop, not just 1'],
        ['bar + zigzag',  'ridge: both sides climb, net level unchanged'],
        ['green chevron', 'ramp, points uphill'],
        ['dashed gold',   'bollard, digits are its registers'],
        ['dashed purple', 'repulsor'],
        ['red dot+line',  'laser emitter, fires inward'],
        ['red dashes',    'beam crossing the cell'],
        ['green/red dot', 'one-way wall gate'],
        ['wrench',        'repair: 1 wrench, 2 crossed, or'],
        ['  + hammer',    'wrench+hammer (heals 1, grants option)'],
        ['bolt in ring',  'generator, 1 energy at end of register'],
        ['top band',      'terrain'],
        ['magenta box',   'NOT DRAWN - see stderr'],
    );
    my $i = 0;
    for my $n (@notes) {
        text($lx, $ly + 16 + $i * 11, sprintf('%-14s %s', @$n),
             size => 7, anchor => 'start', fill => '#333');
        $i++;
    }
    text($lx, $ly + 30 + @notes * 11,
         'Compare against the printed board.', size => 7.5, anchor => 'start',
         fill => '#7a1212', weight => 1);
    text($lx, $ly + 41 + @notes * 11,
         'Disagreement means a wrong label,', size => 7.5, anchor => 'start',
         fill => '#7a1212');
    text($lx, $ly + 52 + @notes * 11,
         'not a wrong drawing.', size => 7.5, anchor => 'start', fill => '#7a1212');
}

emit '</svg>';

open my $o, '>', $out or die "$out: $!";
print $o join("\n", @svg), "\n";
close $o;

printf "wrote %s (%dx%d cells)\n", $out, $W, $H;
printf "  drew: %s\n", join(', ', map { "$_ x$seen_kind{$_}" }
                                  sort keys %seen_kind);
if (%unrendered) {
    printf STDERR "  NOT DRAWN (boxed magenta in the SVG): %s\n",
        join(', ', map { "$_ x$unrendered{$_}" } sort keys %unrendered);
    exit 1;
}
exit 0;
