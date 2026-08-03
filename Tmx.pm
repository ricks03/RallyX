package RoboRally::Tmx;

use strict;
use warnings;
use XML::LibXML;
use File::Basename qw(basename dirname);
use Exporter qw(import);

our $VERSION = '0.02';
our @EXPORT_OK = qw(FH FV FD xform opposite find_file resolve_path);
our %EXPORT_TAGS = (all => \@EXPORT_OK);

# Tiled packs three orientation flags into the high bits of each GID.
use constant {
    FH => 0x80000000,   # flipped horizontally
    FV => 0x40000000,   # flipped vertically
    FD => 0x20000000,   # flipped diagonally (transposed)
};

# Each flag is a permutation of compass directions. Composing them in
# Tiled's order - diagonal, then horizontal, then vertical - covers all
# eight orientations, so mirrored tiles need no special handling.
my %XD = (N => 'W', W => 'N', S => 'E', E => 'S');
my %XH = (E => 'W', W => 'E', N => 'N', S => 'S');
my %XV = (N => 'S', S => 'N', E => 'E', W => 'W');
my %OPP = (N => 'S', S => 'N', E => 'W', W => 'E');

sub xform {
    my ($dir, $flags) = @_;
    return undef unless defined $dir;
    $dir = $XD{$dir} if $flags & FD;
    $dir = $XH{$dir} if $flags & FH;
    $dir = $XV{$dir} if $flags & FV;
    return $dir;
}

sub opposite { defined $_[0] ? $OPP{ $_[0] } : undef }

# Resolve a path recorded inside a .tmx or .tsx.
#
# On the machine the maps were authored on, the recorded absolute path is
# correct and is used as-is. Everywhere else it is meaningless, so fall back
# to matching the basename inside $dir. Returns undef rather than dying: a
# map may reference tilesets it never places.
sub resolve_path {
    my ($declared, $dir) = @_;
    return undef unless defined $declared;
    my $p = $declared =~ s{\\}{/}gr;
    return $p if -f $p;                      # authoring machine: path is real
    return find_file($dir, basename($p));    # anywhere else: match loosely
}

# Filenames in this library drift from what the .tsx files record - case,
# separators, and characters like & that get replaced when files are copied
# around. Collapse everything that is not alphanumeric before comparing.
sub _norm { my $n = lc($_[0]); $n =~ s/[^a-z0-9]//g; return $n }

# Match a basename inside $dir under that normalisation.
sub find_file {
    my ($dir, $want) = @_;
    return undef unless defined $dir && defined $want;
    my $norm = _norm($want);
    opendir(my $dh, $dir) or return undef;
    my @hit = grep { _norm($_) eq $norm } readdir $dh;
    closedir $dh;
    return @hit ? "$dir/$hit[0]" : undef;
}

# Width and height straight out of the PNG IHDR chunk. Kept dependency-free
# on purpose so tmx2board.pl runs without an imaging library.
sub png_size {
    my $path = shift(@_);
    open(my $fh, '<:raw', $path) or return;
    read($fh, my $buf, 24) == 24 or return;
    close $fh;
    return unless substr($buf, 0, 8) eq "\x89PNG\r\n\x1a\n";
    return unpack('N', substr($buf, 16, 4)), unpack('N', substr($buf, 20, 4));
}

sub load {
    my ($class, $path, %opt) = @_;
    # default to the map's own directory: tilesets usually live near the maps
    my $tsxdir = $opt{tsxdir} // (File::Basename::dirname($path) || '.');
    # Optional filename -> tileset-name map, normalised by _norm. A .tmx names
    # only files, while tiles.yml is keyed by tileset name, and the .tsx exists
    # in this pipeline mainly to bridge the two. Callers that already know the
    # mapping (tiles.yml records `file:` on every section) can pass it here and
    # convert with no .tsx present at all. Rendering still needs the real file.
    my $names = { map { _norm($_) => $opt{names}{$_} } keys %{ $opt{names} || {} } };

    my $root = XML::LibXML->load_xml(location => $path)->documentElement;
    my $self = bless {
        path       => $path,
        name       => basename($path) =~ s/\.tmx$//r,
        width      => $root->getAttribute('width') + 0,
        height     => $root->getAttribute('height') + 0,
        tilewidth  => $root->getAttribute('tilewidth') + 0,
        tileheight => $root->getAttribute('tileheight') + 0,
        tilesets   => [],
        layers     => [],
        missing    => [],
    }, $class;

    for my $ts ($root->findnodes('tileset')) {
        my $declared = $ts->getAttribute('source');
        my $tsx = resolve_path($declared, $tsxdir);
        my $base = basename($declared =~ s{\\}{/}gr);
        unless ($tsx) {
            # No .tsx on disk. If the caller told us what this file is called
            # inside, that is everything conversion needs: local tile ids come
            # from gid arithmetic, not from the sheet. Geometry stays zero and
            # the entry is flagged so a renderer can refuse it.
            if (defined(my $name = $names->{ _norm($base) })) {
                push @{ $self->{tilesets} }, {
                    firstgid   => $ts->getAttribute('firstgid') + 0,
                    name       => $name,
                    tilewidth  => $self->{tilewidth},
                    tileheight => $self->{tileheight},
                    columns    => 0,
                    rows       => 0,
                    tilecount  => 0,
                    stale      => 0,
                    tsx        => undef,
                    image      => undef,
                    trans      => undef,
                    inferred   => 1,
                };
            }
            else { push @{ $self->{missing} }, $base }
            next;
        }
        my $t = XML::LibXML->load_xml(location => $tsx)->documentElement;
        my $img = $t->findnodes('image')->[0];
        my $png = $img ? resolve_path($img->getAttribute('source'), $tsxdir) : undef;
        my $tw  = ($t->getAttribute('tilewidth')  || $self->{tilewidth})  + 0;
        my $th  = ($t->getAttribute('tileheight') || $self->{tileheight}) + 0;

        # columns and tilecount in these .tsx files are frequently stale -
        # Oil & Goo claims 1x1 for a 7x5 sheet - so measure the image and
        # fall back to the declared values only if it cannot be read.
        my ($cols, $rows);
        if ($png and my ($iw, $ih) = png_size($png)) {
            ($cols, $rows) = (int($iw / $tw), int($ih / $th));
        }
        my $declared_cols = $t->getAttribute('columns') + 0;
        push @{ $self->{tilesets} }, {
            firstgid  => $ts->getAttribute('firstgid') + 0,
            name      => $t->getAttribute('name'),
            # a tileset may use a different tile size from the map grid;
            # Radiation is 66x66 on a 300x300 map
            tilewidth  => $tw,
            tileheight => $th,
            columns   => $cols || $declared_cols,
            rows      => $rows,
            tilecount => ($cols && $rows) ? $cols * $rows
                                          : $t->getAttribute('tilecount') + 0,
            stale     => ($cols && $declared_cols && $cols != $declared_cols) ? 1 : 0,
            tsx       => $tsx,
            image     => $png,
            trans     => $img ? $img->getAttribute('trans') : undef,
        };
    }
    @{ $self->{tilesets} } = sort { $a->{firstgid} <=> $b->{firstgid} }
                             @{ $self->{tilesets} };

    for my $l ($root->findnodes('layer')) {
        my $vis = $l->getAttribute('visible');
        push @{ $self->{layers} }, {
            id      => $l->getAttribute('id'),
            name    => $l->getAttribute('name'),
            # a hidden layer is not exported to the board art, so it is
            # authoring scaffolding rather than board data
            visible => !(defined $vis && $vis eq '0'),
            data    => [ map { $_ + 0 }
                         grep { length } split /\s*,\s*/, $l->findvalue('data') ],
        };
    }
    return $self;
}

sub name       { $_[0]{name} }
sub width      { $_[0]{width} }
sub height     { $_[0]{height} }
sub tilewidth  { $_[0]{tilewidth} }
sub tileheight { $_[0]{tileheight} }
sub tilesets   { @{ $_[0]{tilesets} } }
sub missing    { @{ $_[0]{missing} } }
# tilesets resolved from the caller's name map rather than from a .tsx on disk
sub inferred   { grep { $_->{inferred} } @{ $_[0]{tilesets} } }

# Visible layers only by default; pass visible => 1 to get everything.
sub layers {
    my ($self, %opt) = @_;
    return @{ $self->{layers} } if $opt{all};
    return grep { $_->{visible} } @{ $self->{layers} };
}

# Split a raw GID into its tileset, local tile id and orientation flags.
sub resolve {
    my ($self, $raw) = @_;
    my $flags = $raw & (FH | FV | FD);
    my $gid   = $raw & ~(FH | FV | FD);
    return undef unless $gid;
    my $set;
    $set = $_ for grep { $gid >= $_->{firstgid} } @{ $self->{tilesets} };
    return undef unless $set;          # tileset referenced but not loaded
    return {
        tileset => $set,
        set     => $set->{name},
        id      => $gid - $set->{firstgid},
        flags   => $flags,
    };
}

# Walk every placed tile: $cb->($col, $row, $tile, $layer)
sub each_tile {
    my ($self, $cb, %opt) = @_;
    my $w = $self->{width};
    for my $layer ($self->layers(%opt)) {
        my $d = $layer->{data};
        for my $i (0 .. $#$d) {
            next unless $d->[$i];
            my $t = $self->resolve($d->[$i]) or next;
            $cb->($i % $w, int($i / $w), $t, $layer);
        }
    }
}

# Sheet position of a tile id, for error messages and labelled contact sheets.
sub sheet_pos {
    my ($self, $t) = @_;
    my $c = $t->{tileset}{columns} or return (undef, undef);
    return ($t->{id} % $c, int($t->{id} / $c));
}

1;

__END__

=head1 NAME

RoboRally::Tmx - read Tiled maps for the RoboRally board pipeline

=head1 SYNOPSIS

    use lib 'lib';
    use RoboRally::Tmx;
    use RoboRally::Tmx qw(xform opposite);

    my $map = RoboRally::Tmx->load('Hairpin2.tmx', tsxdir => 'tilesets');

    $map->each_tile(sub {
        my ($col, $row, $tile, $layer) = @_;
        # $tile = { set, id, flags, tileset }
        my $edge = xform('W', $tile->{flags});
    });

=head1 NOTES

Hidden layers are excluded by default. Layer names in this library are
organisational rather than semantic, so callers should key meaning off
tileset name and tile id, never off the layer a tile appears in.

=cut
