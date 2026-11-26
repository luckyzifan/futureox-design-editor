# ttf-parser 0.25.1

The runtime source, manifest and license texts come from the crates.io 0.25.1 archive.
Archive SHA-256 is d2df906b07856748fa3f6e0ad0cbaa047052d4a7dd609e231c4f72cee8c36f31.
The vendored manifest omits the standalone upstream examples, test targets and development dependencies.

GPOS PairPos format 1 ValueRecords resolve Device and VariationIndex offsets
from the start of the PairSet, as specified by OpenType. Keep the full PairSet
slice for those offsets and the record slice for the glyph search. Reject
inverted hinting device ranges and widen the inclusive length calculation.
[Upstream source](https://github.com/harfbuzz/ttf-parser) · [OpenType GPOS specification](https://learn.microsoft.com/en-us/typography/opentype/otspec184/gpos#value-record)
