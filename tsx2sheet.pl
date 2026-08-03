#!/usr/bin/perl
use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/lib";
use RoboRally::Tmx qw(resolve_path);
use XML::LibXML;
use MIME::Base64 qw(encode_base64);
use File::Basename qw(basename);
use Getopt::Long;

# tsx2sheet.pl [--out F] [--scale N] tileset.tsx
#
# Writes a self-contained SVG contact sheet of a tileset with every tile id
# burned in, for working out what each tile means before adding it to
# tiles.yml. The PNG is embedded, so the SVG can be opened or sent anywhere.
#
# Geometry comes from the image, not from the .tsx: columns and tilecount in
# this library are often stale.

my ($out, $scale) = (undef, 150);
GetOptions('out=s' => \$out, 'scale=i' => \$scale) or die;
my $tsx = shift(@ARGV) or die "usage: $0 [--out F] [--scale N] tileset.tsx\n";

my $dir = $tsx =~ m{^(.*)[/\\][^/\\]+$} ? $1 : '.';
my $doc = XML::LibXML->load_xml(location => $tsx)->documentElement;
my $name = $doc->getAttribute('name');
my $tw   = $doc->getAttribute('tilewidth')  + 0;
my $th   = $doc->getAttribute('tileheight') + 0;

my $imgnode = $doc->findnodes('image')->[0] or die "no <image> in $tsx\n";
my $png = resolve_path($imgnode->getAttribute('source'), $dir)
    or die "cannot find image for $tsx\n";

my ($iw, $ih) = RoboRally::Tmx::png_size($png) or die "$png is not a PNG\n";
my ($cols, $rows) = (int($iw / $tw), int($ih / $th));

my $dcols = $doc->getAttribute('columns') + 0;
my $dcount = $doc->getAttribute('tilecount') + 0;
warn sprintf("note: %s declares columns=%d tilecount=%d, image is %dx%d = %d tiles\n",
    basename($tsx), $dcols, $dcount, $cols, $rows, $cols * $rows)
    if $dcols != $cols || $dcount != $cols * $rows;

open(my $fh, '<:raw', $png) or die "$png: $!";
my $b64 = do { local $/; encode_base64(<$fh>, '') };
close $fh;

my ($S, $LAB) = ($scale, 20);
my ($W, $H) = ($cols * $S, $rows * ($S + $LAB));

$out //= basename($tsx) =~ s/\.tsx$//ri . '-sheet.svg';
open(my $o, '>', $out) or die "$out: $!";
print $o qq{<svg xmlns="http://www.w3.org/2000/svg" }
       . qq{xmlns:xlink="http://www.w3.org/1999/xlink" }
       . qq{width="$W" height="@{[ $H + 26 ]}" font-family="monospace">\n};
print $o qq{<rect width="100%" height="100%" fill="#fbfbf9"/>\n};
print $o qq{<text x="4" y="16" font-size="14" fill="#222">}
       . qq{$name - $cols x $rows, ids 0-@{[ $cols*$rows-1 ]}</text>\n};

# Embed the sheet ONCE and crop each tile with a nested <svg> viewBox.
# Embedding per tile multiplies the file size by the tile count - 35 copies
# of a 1.7 MB PNG produced a 78 MB SVG that no viewer would open.
print $o qq{<defs><image id="sheet" width="$iw" height="$ih" }
       . qq{xlink:href="data:image/png;base64,$b64"/></defs>\n};

for my $i (0 .. $cols * $rows - 1) {
    my ($c, $r) = ($i % $cols, int($i / $cols));
    my ($x, $y) = ($c * $S, 26 + $r * ($S + $LAB));
    printf $o qq{<svg x="%d" y="%d" width="%d" height="%d" viewBox="%d %d %d %d">}
             . qq{<use xlink:href="#sheet"/></svg>\n},
        $x, $y, $S, $S, $c * $tw, $r * $th, $tw, $th;
    print $o qq{<rect x="$x" y="$y" width="$S" height="$S" fill="none" stroke="#bbb"/>\n};
    print $o qq{<rect x="$x" y="$y" width="30" height="16" fill="#111"/>\n};
    print $o qq{<text x="@{[ $x+4 ]}" y="@{[ $y+12 ]}" font-size="11" fill="#fff">$i</text>\n};
    printf $o qq{<text x="%d" y="%d" font-size="10" fill="#777">c%d r%d</text>\n},
        $x + 2, $y + $S + 13, $c, $r;
}
print $o "</svg>\n";
close $o;
print "wrote $out ($cols x $rows, @{[ $cols*$rows ]} tiles)\n";
