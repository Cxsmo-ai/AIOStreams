import pathlib

p = pathlib.Path('README.md')
text = p.read_text(encoding='utf-8')

old_table_row = '| **TorrentClaw**     | Advanced cache detection, season sizes, remapping, and indexer. |'
new_table_row = '| **TorrentClaw**     | Advanced Torrent & Usenet indexer with cache detection, season sizes, remapping, and custom formatting. |'

text = text.replace(old_table_row, new_table_row)

old_features_section = '''### ?? Enhanced Resolver & Parser

- **Rewritten Compiler & Parser**: Advanced stream expression parser and rich editor with inline diagnostics.
- **Native Resolver**: Native date, scene, and episode resolver for precise metadata matching across release formats.
- **Reliability & Cache**: PAR2/RAR support, MKV repair hooks, improved caching, log redaction, and analytics.'''

new_features_section = '''### ? TorrentClaw & Usenet Indexer Engine

- **TorrentClaw Integration**: Full native preset, cache detection (`[Cached]` / `[Uncached]`), automatic title remapping, season pack sizing, and custom TorrentClaw suffix/passthrough hooks.
- **TorrentClaw Usenet Indexer**: Optional toggle enabling TorrentClaw to serve as a Usenet indexer for AIOStreams (supporting NNTP, Unarr indexer compatibility, and smart quota optimization designed to sustain 200GB download limits through heavy monthly usage).
- **Enhanced Stream Formatting**: Clean, standardized stream titles and metadata formatting matching native TorrentClaw output layout across both torrent and Usenet streams.

### ?? Enhanced Resolver & Parser

- **Rewritten Compiler & Parser**: Advanced stream expression parser and rich editor with inline diagnostics.
- **Native Resolver**: Native date, scene, and episode resolver for precise metadata matching across release formats.
- **Reliability & Cache**: PAR2/RAR support, MKV repair hooks, improved caching, log redaction, and analytics.'''

text = text.replace(old_features_section, new_features_section)

p.write_text(text, encoding='utf-8')
print("README updated with TorrentClaw formatting and Usenet indexer details.")
