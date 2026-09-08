# Floatplane playback performance and verification

## Scope

This report covers the Floatplane integration in AIOStreams. The target is a
fresh, direct Floatplane CDN URL delivered to the Stremio client, with no
server-side media proxy and with AV1 variants excluded for broad Android TV
compatibility. Signed manifest and CDN URLs are intentionally not recorded
here.

The work is limited to Floatplane delivery and formatting code. Existing
Nuvio-specific UI, calendar, dimmer, HDR, playback, and navigation changes are
outside this patch and were not reverted.

## Changes in this pass

`packages/core/src/builtins/floatplane/addon.ts` now:

1. Starts the parent-post lookup alongside the first direct delivery request.
   Older posts can expose a playable attachment rather than accepting the
   post id directly; this removes an extra serial request in that path.
2. Tries the two compatibility HLS transports concurrently after direct flat
   delivery fails. The old path waited for MPEG-TS and fMP4 one after another.
3. Limits attachment fallback fan-out to eight attachment ids and requests
   each transport in parallel while preserving the original attachment order.
4. Returns freshly signed direct URLs without server-side CDN preflight probes.
   A preflight would add latency and can incorrectly reject a valid URL when
   the AIOStreams host cannot reach the CDN in the same way as the client.
5. Keeps AV1 filtering, direct CDN delivery, metadata enrichment, duration,
   language, subtitle, resolution, codec, and audio-quality formatting intact.

## Local verification completed

| Check | Result |
|---|---:|
| Core test suite | 201 passed, 0 failed |
| Core TypeScript build | Passed |
| Frontend TypeScript check | Passed |
| Production frontend build | Passed |
| `git diff --check` | Passed; only Git's normal line-ending warning |

The local checks validate compilation and the existing Floatplane codec,
delivery, subtitle, metadata, and stream-formatting tests. They do not prove
that every subscriber account or every CDN edge behaves identically.

## Direct-media baseline

Before the current fallback patch, a live authenticated stream request for a
representative Floatplane post returned five direct CDN variants in about
5.2 seconds. The variants were 2160p, 1080p, 720p, 480p, and 360p; all were
H.264/AVC video with AAC stereo audio, had fresh signed authorization, and did
not contain AV1.

The same five URLs were independently checked with FFprobe and decoded with
FFmpeg for five seconds each. The media duration was 803.52 seconds. Decode
completed for every variant; the observed elapsed times were approximately:

| Variant | Decode check |
|---|---:|
| 2160p | 13.1 s |
| 1080p | 1.37 s |
| 720p | 1.22 s |
| 480p | 1.42 s |
| 360p | 0.59 s |

The 2160p result is a measurement of the test machine/network and decoder,
not a claim about Android TV startup. It is why the client must be allowed to
select a lower variant immediately when the device or network cannot sustain
4K.

## Protocol and implementation research

- The Stremio stream response contract supports a direct `url`, a descriptive
  `behaviorHints.filename`, and `bingeGroup`; it also documents when
  `notWebReady` is appropriate. Floatplane streams use direct URLs and a
  canonical filename so the client can choose and display the source without
  an AIOStreams media proxy: [Stremio stream response documentation](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md).
- Floatplane's documented delivery API exposes on-demand output kinds
  including `flat`, `hls.mpegts`, and `hls.fmp4`. The integration prefers the
  direct flat rendition and retains both HLS transports as compatibility
  fallbacks: [Floatplane API documentation](https://jamamp.github.io/FloatplaneAPIDocs/Redoc/redoc-static.html).
- HLS clients are expected to keep fetching segments ahead of playback and
  playlist updates must remain internally consistent. The AIOStreams server
  therefore returns the signed playlist/media URL rather than rewriting or
  proxying segments: [RFC 8216 HTTP Live Streaming](https://datatracker.ietf.org/doc/html/rfc8216).
- FFmpeg documents connection reuse for repeated HTTP work and separate HLS
  demuxer behavior. The integration avoids doing its own media fetch and lets
  the actual client/player own connection reuse and buffering: [FFmpeg
  demuxer documentation](https://github.com/FFmpeg/FFmpeg/blob/master/doc/demuxers.texi),
  [FFmpeg protocol documentation](https://ffmpeg.org/ffmpeg-protocols.html).
- Public Floatplane tooling confirms that the supported workflow is an
  authenticated API request followed by direct media delivery, not a generic
  video-site scraper: [Floatplane Downloader](https://github.com/Inrixia/Floatplane-Downloader).
- Low-latency streaming research consistently treats startup delay, segment
  availability, and adaptive quality as a joint system problem; reducing
  server-side serial work helps, but cannot guarantee a fixed startup time on
  every CDN route or device: [Toward One-Second Latency](https://arxiv.org/abs/2310.03256),
  [JND-aware low-latency adaptive streaming](https://arxiv.org/abs/2401.15343).

## Required live verification after deployment

The following is the acceptance checklist for the deployed manifest. A result
should not be called fully verified unless each applicable item is observed:

1. Fetch the current manifest and confirm the Floatplane addon instance is
   present and enabled.
2. Open a recent subscribed-channel item and an older long-form item through a
   normal Stremio `stream` request.
3. Measure three repeated requests for each item and record p50/p95 latency.
4. Confirm every returned playable source has a direct Floatplane CDN host,
   a signed query, a non-empty canonical filename, and no AV1 marker.
5. Confirm the returned set includes the expected available resolutions and
   that the highest audio-quality rendition is ordered first for a tied
   resolution.
6. Run FFprobe against each returned variant and verify duration, video
   codec, audio codec, dimensions, and stream readability.
7. Decode a short sample from at least 2160p, 1080p, 720p, and one SD
   rendition. If 2160p is too slow on the test device, verify that 1080p or
   720p starts without waiting for the 4K probe.
8. Request subtitles for the same item and verify valid absolute subtitle
   URLs, language values, and no duplicate tracks.
9. Repeat the stream request after a short delay to verify expired/rotated
   authorization produces a new signed URL rather than a stale cached one.
10. Test an attachment-only post to exercise the bounded attachment fallback.
11. Verify the client plays the returned Floatplane URL directly; the Oracle
   or AIOStreams host must not receive media bytes.
12. Inspect CI and deployment logs for the exact commit under test before
   attributing any latency change to this patch.

## Limitations

No finite test matrix can prove every Floatplane video, entitlement, CDN edge,
subtitle track, codec combination, and Android TV firmware. The strongest
honest claim is the one supported by the local build/tests plus the live
representative stream/decode matrix above. Any authenticated live test must
be repeated after deployment because delivery URLs and tokens are short-lived
and the provider can change its output independently of this repository.
