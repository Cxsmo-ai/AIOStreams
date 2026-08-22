export * from './base.js';
export * from './utils.js';
export * from './stremthru.js';
export * from './torbox.js';
export * from './torbox-client.js';
export * from './torbox-config.js';
export * from './torbox-device-flow.js';
export * from './torbox-presentation.js';
export * from './nzbdav.js';
export * from './altmount.js';
export * from './aiostreams.js';
export * from './deepbrid.js';
export * from './service-failure-isolation.js';

import {
  appConfig,
  constants,
  ServiceId,
  fromUrlSafeBase64,
  resolveServiceTime,
} from '../utils/index.js';
import {
  DebridService,
  DebridServiceConfig,
  DebridError,
  PlaybackInfo,
} from './base.js';
import { StremThruService } from './stremthru.js';
import { TorboxDebridService } from './torbox.js';
import {
  DEFAULT_TORBOX_PLAYBACK_PREFERENCES,
  TorboxClient,
} from './torbox-client.js';
import { StremThruPreset } from '../presets/stremthru.js';
import { NzbDAVService } from './nzbdav.js';
import { AltmountService } from './altmount.js';
import { StremioNNTPService } from './stremio-nntp.js';
import { EasynewsService } from './easynews.js';
import { NativeUsenetService } from './aiostreams.js';
import { DeepbridService } from './deepbrid.js';
import { isolateDebridService } from './service-failure-isolation.js';

export function getDebridService(
  serviceName: ServiceId,
  token: string,
  clientIp?: string,
  options?: Pick<DebridServiceConfig, 'preCache' | 'preCacheLimit'>
): DebridService {
  const config: DebridServiceConfig = {
    token,
    clientIp,
    ...options,
  };

  const pollInterval = resolveServiceTime(
    appConfig.builtins.debrid.downloadPollInterval,
    serviceName
  );
  const maxWaitTime = resolveServiceTime(
    appConfig.builtins.debrid.downloadMaxWaitTime,
    serviceName
  );

  switch (serviceName) {
    case 'torbox': {
      const torboxClient = new TorboxClient();
      const torrentPlaybackResolver = async (input: {
        downloadId: string;
        fileId: number;
        playbackInfo: PlaybackInfo & { type: 'torrent' };
      }) =>
        (
          await torboxClient.resolvePlayback({
            type: 'torrent',
            itemId: input.downloadId,
            fileId: input.fileId,
            token: config.token,
            ...DEFAULT_TORBOX_PLAYBACK_PREFERENCES,
            ...input.playbackInfo.torbox,
          })
        ).url;
      const usenetPlaybackResolver = async (input: {
        downloadId: string;
        fileId: number;
        playbackInfo: PlaybackInfo & { type: 'usenet' };
      }) =>
        (
          await torboxClient.resolvePlayback({
            type: 'usenet',
            itemId: input.downloadId,
            fileId: input.fileId,
            token: config.token,
            ...DEFAULT_TORBOX_PLAYBACK_PREFERENCES,
            ...input.playbackInfo.torbox,
          })
        ).url;
      if (appConfig.builtins.stremthru.torboxUsenetViaStremthru) {
        return isolateDebridService(
          new StremThruService({
            serviceName: 'torbox',
            clientIp: config.clientIp,
            stremthru: {
              baseUrl: appConfig.builtins.stremthru.url,
              store: 'torbox',
              token: config.token,
            },
            capabilities: { torrents: true, usenet: true },
            torrentPlaybackResolver,
            usenetPlaybackResolver,
            cacheAndPlayResolver: (playbackInfo, requested) => {
              const accountValue =
                playbackInfo.type === 'torrent'
                  ? playbackInfo.torbox?.torrentCacheAndPlay
                  : playbackInfo.torbox?.usenetCacheAndPlay;
              return accountValue ?? requested;
            },
            cacheAndPlayOptions: {
              pollingInterval: pollInterval,
              maxWaitTime: maxWaitTime,
            },
          }),
          serviceName,
          token,
          { credentialProbe: () => torboxClient.getUserSettings(token) }
        );
      }
      return isolateDebridService(
        new TorboxDebridService(config, {
          pollInterval,
          maxWaitTime,
        }),
        serviceName,
        token,
        { credentialProbe: () => torboxClient.getUserSettings(token) }
      );
    }
    case 'nzbdav':
      return new NzbDAVService(config, {
        pollingInterval: pollInterval,
        maxWaitTime: maxWaitTime,
      });
    case 'altmount':
      return new AltmountService(config, {
        pollingInterval: pollInterval,
        maxWaitTime: maxWaitTime,
      });
    case 'stremio_nntp':
      return new StremioNNTPService(config);
    case 'easynews':
      return new EasynewsService(config);
    case 'stremthru_newz':
      return createStremThruNewzService(config, pollInterval, maxWaitTime);
    case constants.AIOSTREAMS_SERVICE:
      return new NativeUsenetService(config);
    case constants.DEEPBRID_SERVICE:
      return isolateDebridService(
        new DeepbridService(config),
        serviceName,
        token,
        {
          credentialProbe: () => new DeepbridService(config).validateAccount(),
        }
      );
    default:
      if (StremThruPreset.supportedServices.includes(serviceName)) {
        return new StremThruService({
          serviceName,
          clientIp: config.clientIp,
          stremthru: {
            baseUrl: appConfig.builtins.stremthru.url,
            store: serviceName,
            token: config.token,
          },
          capabilities: { torrents: true, usenet: false },
          cacheAndPlayOptions: {
            pollingInterval: pollInterval,
            maxWaitTime: maxWaitTime,
          },
        });
      }
      throw new Error(`Unknown debrid service: ${serviceName}`);
  }
}

function createStremThruNewzService(
  config: DebridServiceConfig,
  pollInterval: number,
  maxWaitTime: number
): StremThruService {
  let url: string;
  let authToken: string;

  try {
    const parsed = JSON.parse(fromUrlSafeBase64(config.token));
    url = parsed.url;
    authToken = parsed.authToken;
  } catch {
    throw new DebridError(
      'Invalid StremThru Newz credentials. Expected base64-encoded JSON with url and authToken.',
      {
        statusCode: 400,
        statusText: 'Bad Request',
        code: 'BAD_REQUEST',
        headers: {},
        body: {},
      }
    );
  }

  if (!url || !authToken) {
    throw new DebridError(
      'Missing url or authToken in StremThru Newz credentials.',
      {
        statusCode: 400,
        statusText: 'Bad Request',
        code: 'BAD_REQUEST',
        headers: {},
        body: {},
      }
    );
  }

  return new StremThruService({
    serviceName: 'stremthru_newz',
    clientIp: config.clientIp,
    stremthru: {
      baseUrl: url,
      store: 'stremthru',
      token: authToken,
    },
    capabilities: { torrents: false, usenet: true },
    usenetOptions: {
      alwaysCacheAndPlay: true,
      neverAutoRemove: true,
      treatUnknownAsCached: true,
    },
    cacheAndPlayOptions: {
      pollingInterval: pollInterval,
      maxWaitTime: maxWaitTime,
    },
  });
}

export * from './deepbrid-subtitles.js';
