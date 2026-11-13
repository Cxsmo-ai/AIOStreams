import type { DeepbridTorrent } from '@aiostreams/core';

const TORRENT_STATUSES = new Set([
  'queued',
  'downloading',
  'uploading',
  'downloaded',
  'error',
  'dead',
  'magnet_error',
  'virus',
]);

/** Allowlisted torrent status for the profile UI; never forwards provider links or file payloads. */
export function projectDeepbridTorrentStatus(
  torrents: readonly DeepbridTorrent[]
) {
  return torrents.slice(0, 500).map((torrent) => {
    const status = torrent.status.trim().toLowerCase();
    return {
      id: torrent.id.slice(0, 80),
      title: torrent.title.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 500),
      status: TORRENT_STATUSES.has(status) ? status : 'unknown',
      ...(Number.isFinite(torrent.progress)
        ? { progress: Math.max(0, Math.min(100, torrent.progress!)) }
        : {}),
      ...(Number.isFinite(torrent.size) && torrent.size! > 0
        ? { size: torrent.size }
        : {}),
      ...(Number.isSafeInteger(torrent.seeders) && torrent.seeders! >= 0
        ? { seeders: torrent.seeders }
        : {}),
      ...(torrent.speed
        ? {
            speed: torrent.speed
              .replace(/[\u0000-\u001f\u007f]/g, '')
              .slice(0, 80),
          }
        : {}),
    };
  });
}
