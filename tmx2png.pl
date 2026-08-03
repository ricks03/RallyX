#!/usr/bin/perl
use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/lib";   # find the module regardless of cwd
use RoboRally::Tmx qw(FH FV FD);
use PDL;
use Imager;
use File::Basename qw(basename);
use Getopt::Long;

# tmx2png.pl [--tsxdir D] [--out F] [--diff REF] [--tolerance N] map.tmx
#
# Composites a Tiled map into a board image. With --diff it also reports
# how far the render is from the exported art, which is how a board config
# gets proved complete rather than merely plausible.
#
# NOTE: `use PDL` shadows the builtin shift, so every shift here is explicit.

my ($tsxdir, $out, $diff, $tol) = (undef, 'render.png', undef, 1);
GetOptions('tsxdir=s' => \$tsxdir, 'out=s' => \$out,
           'diff=s' => \$diff, 'tolerance=i' => \$tol) or die;
my $tmx = shift(@ARGV)
    or die "usage: $0 [--tsxdir D] [--out F] [--diff REF] map.tmx\n";

# Load a PNG as an RGBA piddle with dims (4, width, height). Imager hands
# back packed samples in the order PDL wants, so this is a copy rather than
# a per-pixel loop.
sub load_rgba {
    my ($path, $trans) = @_;
    my $img = Imager->new(file => $path) or die "$path: " . Imager->errstr;
    my ($w, $h) = ($img->getwidth, $img->getheight);
    # asking a 3-channel image for channel 3 returns short rows and silently
    # corrupts the buffer, so read only the channels that exist
    my @ch = $img->getchannels >= 4 ? (0, 1, 2, 3) : (0, 1, 2);
    my $raw = '';
    $raw .= $img->getsamples(y => $_, channels => \@ch) for 0 .. $h - 1;
    my $src = PDL->new_from_specification(byte, scalar(@ch), $w, $h);
    ${ $src->get_dataref } = $raw;
    $src->upd_data;
    my $p = zeroes(byte, 4, $w, $h);
    $p->slice('0:2') .= $src->slice('0:2');
    $p->slice('(3)') .= (@ch == 4) ? $src->slice('(3)') : 255;
    if ($trans) {                      # magenta key on top of any real alpha
        my ($r, $g, $b) = map { $p->slice("($_)") } 0 .. 2;
        $p->slice('(3)') *= ((($r == 255) & ($g == 0) & ($b == 255)) == 0);
    }
    return $p;
}

my $map = RoboRally::Tmx->load($tmx, tsxdir => $tsxdir);
my ($W, $H, $T) = ($map->width, $map->height, $map->tilewidth);

my %sheet;
for my $ts ($map->tilesets) {
    next unless $ts->{image};
    $sheet{ $ts->{name} } = load_rgba($ts->{image}, $ts->{trans});
}

my %warned;
my $canvas = zeroes(byte, 4, $W * $T, $H * $T);

$map->each_tile(sub {
    my ($col, $row, $t, undef) = @_;
    my $sh = $sheet{ $t->{set} };
    # a placed tile whose tileset image is missing would otherwise vanish
    # from the render and show up only as a puzzling diff
    unless (defined $sh) {
        warn "no image loaded for tileset '$t->{set}' - its tiles will be missing\n"
            unless $warned{ $t->{set} }++;
        return;
    }
    # slice using the TILESET's tile size, which need not match the map grid
    my ($tw, $th) = @{ $t->{tileset} }{qw(tilewidth tileheight)};
    my ($sc, $sr) = $map->sheet_pos($t);
    my $tile = $sh->slice(sprintf ':,%d:%d,%d:%d',
        $sc * $tw, $sc * $tw + $tw - 1, $sr * $th, $sr * $th + $th - 1);

    # Tiled applies the diagonal flip first, then horizontal, then vertical
    $tile = $tile->xchg(1, 2)       if $t->{flags} & FD;
    $tile = $tile->slice(':,-1:0')  if $t->{flags} & FH;
    $tile = $tile->slice(':,:,-1:0') if $t->{flags} & FV;
    $tile = $tile->sever;
    my ($pw, $ph) = ($tile->dim(1), $tile->dim(2));   # after any transpose

    # Tiled anchors a tile to the bottom-left of its cell, which only matters
    # when the tile is smaller than the map grid
    my ($px, $py) = ($col * $T, $row * $T + $T - $ph);
    my $dst = $canvas->slice(sprintf ':,%d:%d,%d:%d',
        $px, $px + $pw - 1, $py, $py + $ph - 1);
    my $a = $tile->slice('(3)')->double / 255;
    for my $ch (0 .. 2) {
        $dst->slice("($ch)") .= ($tile->slice("($ch)")->double * $a
                               + $dst->slice("($ch)")->double * (1 - $a))->rint->byte;
    }
    my ($da, $sa) = ($dst->slice('(3)')->copy, $tile->slice('(3)'));
    $dst->slice('(3)') .= ($sa > $da) * $sa + ($sa <= $da) * $da;
});

my $rgb = $canvas->slice('0:2')->sever;
my $img = Imager->new(xsize => $W * $T, ysize => $H * $T, channels => 3);
my $bytes = ${ $rgb->get_dataref };
$img->setscanline(y => $_, type => '8bit',
    pixels => substr($bytes, $_ * $W * $T * 3, $W * $T * 3)) for 0 .. $H * $T - 1;
$img->write(file => $out) or die Imager->errstr;
printf "wrote %s (%dx%d)\n", $out, $W * $T, $H * $T;

exit 0 unless $diff;

my $d = (load_rgba($diff, undef)->slice('0:2')->long - $rgb->long)->abs->maximum;
my $bad = ($d > $tol);
my $n = $bad->sum->sclr;
printf "differs from %s: %d / %d px (%.4f%%) at tolerance %d\n",
    basename($diff), $n, $d->nelem, 100 * $n / $d->nelem, $tol;
exit 0 unless $n;

my $nd = whichND($bad);
my $u  = ((($nd->slice('(1)') / $T)->floor) * $W
        + (($nd->slice('(0)') / $T)->floor))->uniq;
printf "cells affected (%d): %s\n", $u->nelem,
    join ', ', map { sprintf 'c%dr%d', $_ % $W, int($_ / $W) } list $u;
exit 1;
