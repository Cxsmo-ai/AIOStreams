import pathlib

p = pathlib.Path('README.md')
text = p.read_text(encoding='utf-8')

start_marker = '###  Built-in Addons'
if '### ?? Built-in Addons' in text:
    start_marker = '### ?? Built-in Addons'

end_marker = '### ?? Debrid & Usenet Service Support'
if '###  Debrid & Usenet Service Support' in text:
    end_marker = '###  Debrid & Usenet Service Support'

start_pos = text.find(start_marker)
end_pos = text.find(end_marker, start_pos)

if start_pos != -1 and end_pos != -1:
    new_builtin_section = '''### ?? Built-in Addons & Indexers

AIOStreams includes built-in search engines, indexers, and integrations hosted directly alongside your instance:

- **TorrentClaw Integration**: Advanced cache detection (`[Cached]` / `[Uncached]`), automatic title remapping, season pack sizing, and custom TorrentClaw formatting hooks for clean, standardized stream layouts across torrent and Usenet results.
- **TorrentClaw Usenet Indexer**: Toggle allowing TorrentClaw to serve as a Usenet indexer for AIOStreams (supporting NNTP, Unarr indexer integration, and smart quota optimization designed to sustain 200GB download limits through heavy monthly usage).
- **Unarr Indexer**: Native Usenet indexer support with per-config key validation.
- **Built-in Search Engines & Integrations**: Support for Google Drive, TorBox Search, Knaben, Easynews, SeaDex, Prowlarr, Jackett, Newznab, Torznab, and library browsing.

> [!NOTE]
> Built-in addons that search for torrents require a debrid service. Usenet results can be streamed by AIOStreams' built-in usenet engine, via external tools like [NzbDAV](https://github.com/nzbdav-dev/nzbdav) or [AltMount](https://github.com/javi11/altmount), natively by Stremio itself, or through TorBox.

'''
    text = text[:start_pos] + new_builtin_section + text[end_pos:]
    p.write_text(text, encoding='utf-8')
    print("README simplified successfully.")
else:
    print(f"Markers not found: start_pos={start_pos}, end_pos={end_pos}")
