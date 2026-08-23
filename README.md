<p align="center">
    <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://cdn.jsdelivr.net/gh/selfhst/icons/png/aiostreams-light.png">
        <img alt="AIOStreams Logo" src="https://cdn.jsdelivr.net/gh/selfhst/icons/png/aiostreams.png" width="256" height="256">
    </picture>
</p>

<h1 align="center">AIOStreams — Cxsmo Custom Fork</h1>

<p align="center">
  <strong>AIOStreams with deeper TorrentClaw, Deepbrid, TorBox, Usenet, catalog, metadata, subtitle, and resolver integration.</strong>
  <br />
  Built on <a href="https://github.com/Viren070/AIOStreams">Viren070/AIOStreams</a> and extended in <a href="https://github.com/Cxsmo-ai/AIOStreams">Cxsmo-ai/AIOStreams</a>.
</p>

<p align="center">
    <a href="https://github.com/Cxsmo-ai/AIOStreams/actions/workflows/deploy-docker.yml">
        <img src="https://img.shields.io/github/actions/workflow/status/Cxsmo-ai/AIOStreams/deploy-docker.yml?style=for-the-badge&logo=github" alt="Build Status">
    </a>
    <a href="https://github.com/Cxsmo-ai/AIOStreams/releases/latest">
        <img src="https://img.shields.io/github/v/release/Cxsmo-ai/AIOStreams?style=for-the-badge&logo=github" alt="Latest Release">
    </a>
    <a href="https://github.com/Cxsmo-ai/AIOStreams/stargazers">
        <img src="https://img.shields.io/github/stars/Cxsmo-ai/AIOStreams?style=for-the-badge&logo=github" alt="GitHub Stars">
    </a>
    <a href="https://github.com/Cxsmo-ai/AIOStreams/pkgs/container/aiostreams">
        <img src="https://img.shields.io/badge/GHCR-multi--arch-2496ED?style=for-the-badge&logo=github" alt="GHCR multi-architecture image">
    </a>
</p>

> [!IMPORTANT]
> This repository is a **custom community fork**, not the official upstream AIOStreams repository. The original AIOStreams project and core architecture are maintained by [Viren070](https://github.com/Viren070). This fork adds and maintains its own integrations, behavior, performance work, and service-specific features on top of that foundation.

## 📦 GHCR Images

Official container images for **this fork** are published through GitHub Container Registry:

- **Package page:** [github.com/Cxsmo-ai/AIOStreams/pkgs/container/aiostreams](https://github.com/Cxsmo-ai/AIOStreams/pkgs/container/aiostreams)
- **Registry image:** `ghcr.io/cxsmo-ai/aiostreams`

```bash
docker pull ghcr.io/cxsmo-ai/aiostreams:latest
```

```bash
podman pull ghcr.io/cxsmo-ai/aiostreams:latest
```

> [!NOTE]
> Use the **Cxsmo-ai GHCR image** if you want the custom TorrentClaw, Deepbrid, TorBox, Usenet, catalog, metadata, subtitle, and resolver changes documented in this README.

---

## ✨ What Makes This Fork Different?

The goal of this fork is not to replace the AIOStreams core experience. It extends it into a deeper multi-source streaming and Usenet stack where **TorrentClaw, Deepbrid, TorBox, native AIOStreams Usenet, external indexers, metadata, catalogs, and subtitles can work together instead of acting like isolated addons**.

The fork focuses heavily on:

- preserving **every valid source** after filtering and deduplication rather than imposing arbitrary caps;
- resolver-aware routing across **TB**, **DB**, and **AIO** playback paths;
- native and external **Usenet/NZB** workflows;
- season-pack discovery and exact episode extraction;
- richer TorrentClaw metadata and catalogs;
- robust fallback behavior when individual providers fail or rate-limit;
- safer playback probing, proxying, quotas, retries, and timeouts;
- larger catalogs, artwork fallbacks, NSFW filtering, and universal subtitle handling.

<p align="center">
  <img src="https://github.com/user-attachments/assets/ba15f9f6-b8d4-4060-9b1f-00adeb0d1d9b" alt="AIOStreams in action" width="850" />
</p>

---

## 🚀 Custom Fork Features

### 🦅 TorrentClaw

- **Native TorrentClaw torrent and Usenet integration**
- **Unarr archive support** with NZB quota protection
- Season-pack discovery with correct episode extraction
- Improved release parsing, metadata, posters, logos, and backgrounds
- Larger catalogs with pagination and NSFW filtering
- Separate **For You** and **What You Guys Should Watch** catalogs
- Resolver-aware labels: `⚡ TB`, `⚡ DB`, or `⚡ AIO`
- Valid TorrentClaw results are preserved through filtering and deduplication

### 🔎 Deepbrid Usenet

- Built-in **Deepbrid Usenet Finder** addon
- Shared service authentication — no separate addon API key required
- External NZB/indexer resolving
- Optional pre-cache mode with on-demand fallback
- Failed or rate-limited pre-cache requests do not hide otherwise valid sources
- Season-pack searching and episode extraction
- Archive handling, playback probing, and secure range proxying
- Duplicate external results already found by Deepbrid Finder are suppressed intelligently
- Deepbrid-specific formatting and service badges

### ⚡ Usenet & Indexers

- Better **TorBox, Deepbrid, Newshosting, and Easynews NNTP** workflows
- Improved altHUB, Easynews, Newshosting, Prowlarr, and TorrentClaw resolving
- External indexers can resolve through **TorBox**, **Deepbrid**, or native **AIOStreams**
- Native AIOStreams sources remain available alongside TB and DB results
- Better NZB parsing, season-pack matching, archive extraction, and playback selection
- Configurable TorBox/Deepbrid priority without removing valid sources
- NNTP emergency/fallback tiers for more resilient provider routing

### 🧩 Services & Resolver Routing

- Shared service credentials and resolver-aware routing
- TorBox cache-and-play, native streaming, and transcoding support
- Deepbrid pre-cache and external-indexer resolving
- Storage, quota, retry, timeout, and provider-failure safeguards
- Partial results remain visible when individual providers fail
- Resolver labels and formatting make the final playback path obvious

#### ⚡ TorBox Service Menu

<p align="center">
  <img src="https://media.discordapp.net/attachments/1499673391429320764/1541188108509249556/tobox_service.jpeg?ex=6a8caec6&is=6a8b5d46&hm=fd6e300c9a314a279938658c0d6a8fe096be71dfcde42e4b16c368361ae094e9&=&format=webp&width=2048&height=1302" alt="Cxsmo AIOStreams TorBox service menu" width="1500" />
</p>

#### 🌐 Services Tab

<p align="center">
  <img src="https://media.discordapp.net/attachments/1499673391429320764/1541188107729371196/services.jpeg?ex=6a8caec6&is=6a8b5d46&hm=197a0bc6b0be210760bf70cf6c242e0b662cf4b3f0efd751b8037eaf97d59b91&=&format=webp&width=2048&height=1302" alt="Cxsmo AIOStreams Services tab" width="1500" />
</p>

### 🎬 Catalogs & Metadata

- Expanded TorrentClaw catalogs with **larger pagination and infinite scrolling**
- Separate **TorrentClaw · For You** and **What You Guys Should Watch** catalogs
- Platform-specific **Top Streaming** catalogs
- Watchlist season entries normalize back to the **complete show** instead of appearing as separate season items
- Improved TorrentClaw metadata mapping for titles, years, seasons, episodes, and IDs
- Better poster, background, logo, description, and metadata fallbacks
- Improved compatibility across **IMDb, TMDB, Cinemeta, and Stremio metadata**
- NSFW filtering applied across catalog titles, descriptions, genres, artwork, and metadata
- Catalog pagination preserves valid entries instead of dropping results between pages

### 💬 Subtitles

- Deepbrid OpenSubtitles integration
- Universal subtitle handling across AIOStreams, TB, DB, TorrentClaw, and external sources
- Improved subtitle language metadata and formatting

### 🚀 Performance & Reliability

- Parallel provider requests and batched indexer processing
- Internal timeout margins, retries, rate-limit handling, and fallbacks
- Improved Deepbrid and Prowlarr response times
- Accurate unique-stream counts after deduplication
- HTTP range validation and safer playback handling
- Valid sources are preserved instead of being artificially limited
- Privacy-safe provider performance statistics and diagnostics

> [!TIP]
> **Main difference:** this fork turns AIOStreams into a more deeply connected **TorrentClaw + Deepbrid + TorBox + Usenet ecosystem** with service routing, external-indexer resolving, Unarr support, season-pack extraction, resolver-aware formatting, larger filtered catalogs, pre-cache fallbacks, and multi-method source preservation.

---

## 🧱 Core AIOStreams Features Retained

This fork keeps the core AIOStreams experience and UI foundations while extending them with the fork-specific integrations above. The original README screenshots are retained here because these interfaces remain relevant to this fork.

### 🔌 One Interface for Your Addons

- Add community or custom Stremio addons in one place
- Unified filtering, sorting, formatting, metadata, catalogs, and subtitles
- Dynamic manifests and configuration profiles
- Built-in and external debrid/Usenet service support
- Addon categorization and centralized service configuration

<p align="center">
  <img src="https://media.discordapp.net/attachments/1499673391429320764/1541188108127707136/addons.jpeg?ex=6a8caec6&is=6a8b5d46&hm=84baa09a0e2f347006b883e3c941dde63219cddc81eabd2f73f8e021d132e445&=&format=webp&width=2048&height=1215" alt="Cxsmo AIOStreams Addons tab" width="850" />

  <img src="https://github.com/user-attachments/assets/fc85afc5-1367-40e0-9018-40002dd0878f" alt="AIOStreams addon configuration" width="850" />
</p>

### 🔬 Advanced Filtering & Deduplication

- Resolution, quality, encode, HDR/DV, audio, language, size, bitrate, seeders, age, cache status, and stream-type filtering
- Keyword and regex filters
- Stream Expression Language support
- Content-aware matching
- Smart deduplication by filename, infohash, size, and other stream properties

<p align="center">
  <img src="https://github.com/user-attachments/assets/4bab4c2c-a47a-482b-a623-079fc792dc33" alt="Filtering Configuration" width="750" />
</p>

### 📊 Powerful Sorting

- Stack multiple sort criteria in any order
- Different rules for movies, series, and anime
- Separate cached/uncached logic
- Expression/regex scoring and preferred-value lists

<p align="center">
  <img src="https://github.com/user-attachments/assets/88eb560d-d95d-4964-93ed-7b6b82c861b9" alt="AIOStreams sorting configuration" width="920" />
</p>

### 🎨 Custom Stream Formatter

- Live preview
- Built-in and community-inspired formats
- Formatter access to parsed stream attributes

<p align="center">
  <img src="https://github.com/user-attachments/assets/44ba6860-6778-4f0f-a192-e3f28df6b893" alt="Custom Stream Formatter" width="900" />
</p>

### 🗃️ Unified Catalog Management

- Rename, reorder, disable, shuffle, and merge catalogs
- Enhanced poster support
- Unified catalog control from one configuration

<p align="center">
  <img src="https://github.com/user-attachments/assets/24d2ea64-f742-48f0-8552-bb8a62f61a75" alt="Unified Catalog Management" width="900" />
</p>

### 🛡️ Proxy Support

- Built-in stream proxy
- MediaFlow Proxy and StremThru compatibility
- NZB proxying
- Outgoing HTTP/SOCKS5 request proxy support

---

## 🚀 Getting Started

1. **Deploy this fork**
   - Self-host from this repository or pull the fork image from **`ghcr.io/cxsmo-ai/aiostreams:latest`**.
   - GHCR package page: [Cxsmo-ai/AIOStreams / aiostreams](https://github.com/Cxsmo-ai/AIOStreams/pkgs/container/aiostreams)

2. **Open the configuration page**
   - Go to `/stremio/configure` on your instance.

3. **Configure services and addons**
   - Add the debrid and/or Usenet services you use.
   - Enable built-in or external addons and configure filtering, sorting, catalogs, subtitles, and formatting.

4. **Save and install**
   - Create or protect your configuration, then use the provided installation options for your Stremio-compatible client.

> [!NOTE]
> Upstream documentation remains useful for core AIOStreams behavior: [docs.aiostreams.viren070.me](https://docs.aiostreams.viren070.me). Fork-specific behavior may differ where this repository extends or overrides upstream integrations.

---

<a id="deepbrid-support"></a>

## 🎁 Support This Fork — Deepbrid Referral

This fork is free and open-source. If you already plan to **sign up for Deepbrid or renew/purchase a Deepbrid plan**, using the referral link below is a simple way to support continued development of the custom TorrentClaw, Deepbrid, Usenet, resolver, catalog, subtitle, and performance work in this repository.

### 👉 [Sign Up / Continue to Deepbrid](https://www.deepbrid.com/aff/go/pickymarker4906) 👈

> [!IMPORTANT]
> **Affiliate disclosure:** the Deepbrid link above is an affiliate/referral link. If your purchase qualifies, the maintainer of this fork may receive a referral commission. Using it does not change the purpose or licensing of this open-source project.

### How to make sure the referral is recognized

1. Open an Incognito/Private window or clear old Deepbrid referral cookies if needed.
2. Click the referral link immediately before signing in or creating your account.
3. Complete your Deepbrid purchase in the same browsing session when possible.

### Sharing this project on Reddit or forums

If a community filters raw affiliate URLs, link people to this README section instead:

```text
https://github.com/Cxsmo-ai/AIOStreams#deepbrid-support
```

That lets readers see the disclosure and referral instructions before choosing whether to use the link.

---

## ❤️ Support This Fork

If you want to support **this custom fork** and its continued development:

- ⭐ **[Star Cxsmo-ai/AIOStreams](https://github.com/Cxsmo-ai/AIOStreams)**
- 📦 **[Use the Cxsmo-ai GHCR image](https://github.com/Cxsmo-ai/AIOStreams/pkgs/container/aiostreams)**
- 👑 **[Support me on Throne](https://throne.com/cxsmo)**
- 🎁 **[Use the Deepbrid referral link](https://www.deepbrid.com/aff/go/pickymarker4906)** if you already plan to purchase or renew Deepbrid
- 🤝 Open issues or contribute improvements directly to this repository

> [!NOTE]
> All support links above are for **this custom fork / Cxsmo**. This README does not include donation, sponsor, or fundraising links for the upstream project. Upstream AIOStreams is credited below strictly for attribution to the original codebase and architecture.

---

<h2 align="center">⭐ Fork Star History</h2>

<p align="center">
  <img src="https://api.star-history.com/svg?repos=Cxsmo-ai/AIOStreams&type=Date" alt="Cxsmo-ai/AIOStreams Star History" width="750" />
</p>

---

## 🙏 Credits & Attribution

### Upstream foundation

This fork is derived from **[Viren070/AIOStreams](https://github.com/Viren070/AIOStreams)** and therefore retains attribution to that project and its contributors. The upstream codebase provides the original AIOStreams architecture, configuration system, aggregation pipeline, filtering/sorting/formatting framework, service abstractions, catalog system, proxy features, UI foundations, and other core components this fork extends.

This attribution is provided to clearly identify the origin of the codebase. **Cxsmo-ai/AIOStreams is a separate custom fork with its own integrations, behavior, packaging, releases, and support links.**

### Custom fork work

**[Cxsmo-ai/AIOStreams](https://github.com/Cxsmo-ai/AIOStreams)** maintains the fork-specific integration and behavior described above, including the deeper TorrentClaw, Deepbrid, TorBox, Usenet/indexer, resolver-routing, catalog, metadata, subtitle, performance, quota, proxy, and source-preservation work.

### Services, addons & ecosystem projects

This fork interoperates with or builds integration logic around services and projects including **TorrentClaw, Deepbrid, TorBox, Newshosting, Easynews, altHUB, Prowlarr, Unarr, Stremio, IMDb, TMDB, OpenSubtitles, NzbDAV, AltMount, MediaFlow Proxy, and StremThru**. Their names and trademarks belong to their respective owners. Inclusion here does not imply endorsement, sponsorship, or affiliation unless explicitly stated by the respective project/service.

### Upstream/open-source acknowledgements retained

Special thanks to the projects credited by upstream AIOStreams and to the wider open-source ecosystem it builds on:

- [5rahim/seanime](https://github.com/5rahim/seanime) — UI components and issue-template inspiration/adaptation credited by upstream
- [nzbdav-dev/nzbdav](https://github.com/nzbdav-dev/nzbdav)
- [javi11/altmount](https://github.com/javi11/altmount)
- [Sanket9225/UsenetStreamer](https://github.com/Sanket9225/UsenetStreamer/) — inspiration for NzbDAV/AltMount integration credited by upstream
- [sleeyax/stremio-easynews-addon](https://github.com/sleeyax/stremio-easynews-addon) — initial-structure inspiration credited by upstream
- [diced/zipline](https://github.com/diced/zipline) — formatter-system inspiration/adaptation credited by upstream
- [silentmatt/expr-eval](https://github.com/silentmatt/expr-eval) — powers the Stream Expression Language
- Every addon, indexer, provider, library, contributor, tester, and upstream maintainer whose work makes the AIOStreams ecosystem possible

If a credit or attribution is missing, please open an issue so it can be corrected.

---

## ⚠️ Disclaimer

This project is an aggregation, configuration, and interoperability tool. It does **not** host, store, or distribute media content itself. Users are responsible for complying with applicable laws and with the terms of the services, indexers, addons, providers, and content sources they configure.

This community fork is **not affiliated with or endorsed by Stremio, Deepbrid, TorBox, TorrentClaw, IMDb, TMDB, OpenSubtitles, or other third-party services mentioned in this README**, unless explicitly stated otherwise.

Use third-party credentials, services, and subscriptions only in ways permitted by their respective terms and policies.