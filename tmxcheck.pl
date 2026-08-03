#!/usr/bin/perl
use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/lib";
use YAML::PP;
use XML::LibXML;
use File::Basename qw(basename);
use Getopt::Long;

# tmxcheck.pl [--tiles F] map.tmx [map.tmx ...]
#
# Answers one question from the .tmx alone: is every tileset this map
# references already configured in tiles.yml?
#
# The catch this works around: tiles.yml is keyed by the tileset NAME
# attribute inside the .tsx, while a .tmx records only FILENAMES, and in this
# library the two differ - Ledges.tsx is named "Ramps/Ledges" inside. So each
# tiles.yml section carries a `file:` key naming the .tsx it came from, and
# this tool matches on that. A section without one cannot be matched, and is
# listed at the end so the gap is visible rather than silent.
#
# Filenames are compared with everything non-alphanumeric stripped, the same
# normalisation the tileset loader uses, so case, spaces, underscores and dots
# do not matter.
#
# Needs no .tsx and no .png. Exit 1 if the map actually USES something that
# is unconfigured. A tileset the map declares but never places is reported
# for information and does not fail the run - Tiled leaves those references
# behind whenever a sheet is loaded and then not used.

my $tiles_file = "$FindBin::Bin/tiles.yml";
GetOptions('tiles=s' => \$tiles_file) or die;
@ARGV or die "usage: $0 [--tiles F] map.tmx [map.tmx ...]\n";

use constant FLAGS => 0xE0000000;   # the three orientation bits

sub norm { my $n = lc($_[0]); $n =~ s/[^a-z0-9]//g; return $n }

my $SEM = YAML::PP->new->load_file($tiles_file);

# Two ways to tie a .tmx reference to a section.
#
#   1. `file:` on the section. Recorded from the .tsx, so it is fact.
#   2. The section name itself. For most sheets the .tsx is named after the
#      tileset, so RallyX.tsx lands on "RallyX". That is a guess and is
#      reported as one, because it is not reliable: Ledges.tsx is named
#      "Ramps/Ledges" inside, and 05A may well live in 05TilesetA.tsx.
my (%by_file, %by_name, @unindexed);
for my $name (sort keys %$SEM) {
    my $f = $SEM->{$name}{file};
    if (defined $f) { $by_file{ norm(basename($f)) } = $name }
    else            { push @unindexed, $name; $by_name{ norm($name) } = $name }
}
my %claimed;

my $bad = 0;

for my $tmx (@ARGV) {
    print "=" x 68, "\n$tmx\n", "=" x 68, "\n";

    my $root = eval { XML::LibXML->load_xml(location => $tmx)->documentElement };
    unless ($root) { print "  UNREADABLE: $@"; $bad++; next }

    # every reference, in firstgid order, with the gid range it owns
    my @ts;
    for my $t ($root->findnodes('tileset')) {
        my $src = $t->getAttribute('source');
        push @ts, {
            firstgid => $t->getAttribute('firstgid') + 0,
            declared => $src,
            base     => defined $src ? basename($src =~ s{\\}{/}gr)
                                     : ($t->getAttribute('name') // '?') . ' [inline]',
            inline   => !defined $src,
            placed   => 0,
        };
    }
    @ts = sort { $a->{firstgid} <=> $b->{firstgid} } @ts;
    $ts[$_]{last} = $_ < $#ts ? $ts[$_ + 1]{firstgid} - 1 : ~0 for 0 .. $#ts;

    # Count placements so an unconfigured sheet the map never uses can be told
    # apart from one it does. Layer data here is CSV; anything else would
    # silently count zero, so it is called out instead.
    my ($noncsv, @layers) = (0);
    for my $l ($root->findnodes('//layer')) {
        my ($d) = $l->findnodes('data');
        next unless $d;
        my $vis = $l->getAttribute('visible');
        my $lay = {
            name    => $l->getAttribute('name') // '(unnamed)',
            hidden  => (defined $vis && $vis eq '0') ? 1 : 0,
            tiles   => 0,
            use     => {},        # tileset base -> { local id => 1 }
        };
        push @layers, $lay;
        my $enc = $d->getAttribute('encoding') // '';
        if ($enc ne 'csv') { $noncsv++; next }
        # split on commas AND whitespace: the CSV block is newline-wrapped, so
        # splitting on commas alone leaves a newline on the first entry of
        # every layer and a digit test then silently drops it
        for my $g (grep { length } split /[\s,]+/, $d->textContent) {
            next unless $g =~ /^\d+$/;
            my $gid = $g & ~FLAGS;
            next unless $gid;
            for my $t (@ts) {
                if ($gid >= $t->{firstgid} && $gid <= $t->{last}) {
                    $t->{placed}++;
                    $lay->{tiles}++;
                    # local id is gid - firstgid, both of which are in the .tmx,
                    # so tile coverage can be checked with no .tsx at all
                    $lay->{use}{ $t->{base} }{ $gid - $t->{firstgid} } = 1;
                    last;
                }
            }
        }
    }
    print "  WARNING: $noncsv layer(s) are not CSV-encoded, so their tiles are\n",
          "           not counted and 'placed' below understates the truth\n" if $noncsv;

    # layers nested in a <group> are invisible to the converter, which walks
    # only direct children of the map
    my ($deep, $flat) = map { $root->findnodes($_)->size } '//layer', 'layer';
    print "  WARNING: only $flat of $deep tile layers are top-level; the rest sit\n",
          "           inside groups and the converter will not see them\n" if $deep != $flat;

    my (@ok, @guess, @unknown);
    for my $t (@ts) {
        if ($t->{inline}) { push @unknown, $t; next }
        my $n = norm($t->{base});
        # the section name has no extension on it, so compare the stem
        (my $stem = $t->{base}) =~ s/\.tsx$//i;
        if (defined(my $sec = $by_file{$n})) {
            $t->{section} = $sec; $claimed{$sec}++; push @ok, $t;
        }
        elsif (defined($sec = $by_name{ norm($stem) })) {
            $t->{section} = $sec; $claimed{$sec}++; push @guess, $t;
        }
        else { push @unknown, $t }
    }

    printf "\n  %d tileset reference(s): %d confirmed, %d matched by name, %d unmatched\n",
        scalar @ts, scalar @ok, scalar @guess, scalar @unknown;

    if (@ok) {
        print "\n  Configured, confirmed by the section's file: key:\n";
        printf "    %-30s %5d placed  -> \"%s\"\n",
            $_->{base}, $_->{placed}, $_->{section} for @ok;
    }

    if (@guess) {
        print "\n  Configured, MATCHED BY NAME ONLY - the section has no file: key,\n",
              "  so this is inference from the filename, not fact:\n";
        printf "    %-30s %5d placed  -> \"%s\"\n",
            $_->{base}, $_->{placed}, $_->{section} for @guess;
    }

    if (@unknown) {
        print "\n  NOT IN tiles.yml:\n";
        for my $t (@unknown) {
            printf "    %-30s %5d placed%s\n", $t->{base}, $t->{placed},
                $t->{placed} ? '  <-- the map uses it' : '  (never placed)';
            printf "      declared as: %s\n", $t->{declared} if defined $t->{declared};
        }
        # only a sheet the map actually draws from is a problem
        $bad++ if grep { $_->{placed} } @unknown;
    }
    # Tile-level coverage. A section that exists is not the same as a section
    # that covers what this board places.
    my %sec_of = map { $_->{base} => $_->{section} } (@ok, @guess);
    my (%gap, $checked, $covered);
    print "\n  Layers, and whether every tile they place has an entry:\n";
    for my $lay (@layers) {
        my @notes;
        for my $base (sort keys %{ $lay->{use} }) {
            my @ids = sort { $a <=> $b } keys %{ $lay->{use}{$base} };
            my $sec = $sec_of{$base};
            unless (defined $sec) {
                push @notes, sprintf('%s: no section at all (ids %s)', $base, join ',', @ids);
                $gap{$base}{$_} = 1 for @ids;
                next;
            }
            my @miss = grep { !exists $SEM->{$sec}{$_} } @ids;
            $checked += @ids;
            $covered += @ids - @miss;
            if (@miss) {
                push @notes, sprintf('%s: MISSING ids %s', $base, join ',', @miss);
                $gap{$base}{$_} = 1 for @miss;
            }
        }
        printf "    %-30s %4d tiles%s  %s\n",
            $lay->{name} . ($lay->{hidden} ? ' [hidden]' : ''),
            $lay->{tiles},
            $lay->{hidden} ? ' (not converted)' : '                ',
            @notes ? join('; ', @notes) : ($lay->{tiles} ? 'all mapped' : '-');
    }

    if (%gap) {
        print "\n  UNMAPPED TILES, by sheet:\n";
        for my $base (sort keys %gap) {
            printf "    %-30s ids %s\n", $base,
                join ', ', sort { $a <=> $b } keys %{ $gap{$base} };
        }
        $bad++;
    }
    else { print "\n  Every placed tile has an entry.\n" }
    print "\n";
}

my @unclaimed = grep { !$claimed{$_} } @unindexed;
if (@unclaimed) {
    print "-" x 68, "\n";
    printf "%d tiles.yml section(s) have no file: key and were not matched by any\n"
         . "map above. If something is listed as NOT IN tiles.yml, it may be one of\n"
         . "these under a filename that does not match its name:\n",
        scalar @unclaimed;
    print "  $_\n" for @unclaimed;
    print "\nRecording `file: <name>.tsx` on a section removes the guesswork for good.\n";
}

exit($bad ? 1 : 0);
