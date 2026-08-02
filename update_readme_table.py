import pathlib

p = pathlib.Path('README.md')
lines = p.read_text(encoding='utf-8').splitlines()

# Lines 70 to 100 in zero-indexed: 70 is '### ?? Built-in Addons' and 100 is line '| **Library**...'
# 101 is empty line before '### ?? Debrid & Usenet Service Support'

new_section = [
    "### ?? Built-in Addons & Indexers",
    "",
    "AIOStreams includes built-in search engines, indexers, and integrations hosted directly alongside your instance:",
    "",
    "- **TorrentClaw Integration**: Advanced cache detection (`[Cached]` / `[Uncached]`), automatic title remapping, season pack sizing, and custom TorrentClaw formatting hooks for clean, standardized stream layouts across torrent and Usenet results.",
    "- **TorrentClaw Usenet Indexer**: Toggle allowing TorrentClaw to serve as a Usenet indexer for AIOStreams (supporting NNTP, Unarr indexer integration, and smart quota optimization designed to sustain 200GB download limits through heavy monthly usage).",
    "- **Unarr Indexer**: Native Usenet indexer support with per-config key validation.",
    "- **Built-in Search Engines & Integrations**: Support for Google Drive, TorBox Search, Knaben, Easynews, SeaDex, Prowlarr, Jackett, Newznab, Torznab, and library browsing.",
    "",
    "> [!NOTE]",
    "> Built-in addons that search for torrents require a debrid service. Usenet results can be streamed by AIOStreams' built-in usenet engine, via external tools like [NzbDAV](https://github.com/nzbdav-dev/nzbdav) or [AltMount](https://github.com/javi11/altmount), natively by Stremio itself, or through TorBox.",
    ""
]

updated_lines = lines[:70] + new_section + lines[101:]
p.write_text('\n'.join(updated_lines) + '\n', encoding='utf-8')
print("README updated successfully.")
