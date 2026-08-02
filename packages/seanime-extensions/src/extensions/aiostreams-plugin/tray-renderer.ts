import { DownloadManager } from './download-manager';
import { ResultsPanel } from './results-panel';
import { StreamCache } from './stream/cache';
import { Context, DownloadRecord } from './types';

interface TrayHandlers {
  reopenPanel: string;
  clearCache: string;
}

function badgeFor(record: DownloadRecord): {
  text: string;
  intent: 'info' | 'success' | 'alert' | 'gray';
} {
  if (record.status === 'downloading') {
    return { text: `${Math.round(record.percentage)}%`, intent: 'info' };
  }
  if (record.status === 'completed') return { text: 'Done', intent: 'success' };
  if (record.status === 'error') return { text: 'Error', intent: 'alert' };
  return { text: 'Stopped', intent: 'gray' };
}

export class AIOStreamsTray {
  readonly tray: $ui.Tray;

  constructor(
    private readonly ctx: Context,
    private readonly panel: ResultsPanel,
    private readonly cache: StreamCache,
    private readonly downloads: DownloadManager,
    private readonly handlers: TrayHandlers
  ) {
    this.tray = ctx.newTray({
      iconUrl:
        'https://cdn.jsdelivr.net/gh/selfhst/icons/png/aiostreams-light.png',
      withContent: true,
      width: '260px',
      minHeight: '80px',
    });

    this.tray.onOpen(() => this.tray.update());
    this.tray.render(() => this.renderContent());
    this.downloads.setOnChange(() => this.tray.update());

    // Keep tray fresh when results change (so "Reopen last results" stays accurate)
    ctx.effect(() => {
      this.tray.update();
    }, [panel.wvState]);
  }

  update(): void {
    this.tray.update();
  }

  close(): void {
    this.tray.close();
  }

  private renderContent(): unknown {
    const tray = this.tray;
    const cacheCount = this.cache.count();
    const configureUrl = this.ctx.preferences.manifestUrl;
    const lastState = this.panel.wvState.get();
    const hasLastResults =
      lastState.results.length > 0 || lastState.error !== null;

    const items: unknown[] = [
      tray.text('AIOStreams', {
        style: { fontWeight: '600', fontSize: '14px' },
      }),
      tray.text(
        cacheCount === 0
          ? 'Cache is empty'
          : `${cacheCount} cached ${cacheCount === 1 ? 'lookup' : 'lookups'}`,
        { style: { fontSize: '12px', color: 'rgba(255,255,255,0.5)' } }
      ),
    ];

    if (hasLastResults) {
      items.push(
        tray.button('Reopen last results', {
          onClick: this.handlers.reopenPanel,
          intent: 'primary-subtle',
          size: 'sm',
        })
      );
    }

    items.push(
      tray.button('Clear Cache', {
        onClick: this.handlers.clearCache,
        intent: 'gray-subtle',
        size: 'sm',
      })
    );

    if (this.downloads.records.length > 0) {
      items.push(
        tray.div([], {
          style: {
            borderTop: '1px solid rgba(255,255,255,0.08)',
            marginTop: '2px',
            marginBottom: '2px',
          },
        })
      );

      items.push(
        tray.flex(
          [
            tray.text('Downloads', {
              style: {
                fontSize: '11px',
                fontWeight: '600',
                color: 'rgba(255,255,255,0.4)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              },
            }),
            ...(this.downloads.hasFinished()
              ? [
                  tray.button('Clear done', {
                    onClick: this.downloads.clearFinishedHandlerId,
                    intent: 'gray-subtle',
                    size: 'sm',
                  }),
                ]
              : []),
          ],
          {
            style: {
              justifyContent: 'space-between',
              alignItems: 'center',
            },
          }
        )
      );

      for (const record of this.downloads.records) {
        const isActive = record.status === 'downloading';
        const badge = badgeFor(record);
        items.push(
          tray.flex(
            [
              tray.text(record.filename, {
                className: 'text-xs truncate min-w-0 flex-1 text-[--gray]',
              }),
              tray.flex(
                [
                  tray.badge({ text: badge.text, intent: badge.intent }),
                  tray.button(isActive ? 'Stop' : '×', {
                    onClick: isActive
                      ? record.cancelHandlerId
                      : record.dismissHandlerId,
                    intent: 'gray-subtle',
                    size: 'sm',
                  }),
                ],
                {
                  style: {
                    gap: '4px',
                    alignItems: 'center',
                    flexShrink: '0',
                  },
                }
              ),
            ],
            { style: { alignItems: 'center', gap: '6px', width: '100%' } }
          )
        );
      }
    }

    if (configureUrl) {
      items.push(
        tray.anchor({
          text: 'Configure',
          href: configureUrl,
          target: '_blank',
          className:
            'bg-gray-100 border border-transparent hover:bg-gray-200 active:bg-gray-300 dark:bg-opacity-10 dark:hover:bg-opacity-20 text-[rgb(125,140,255)] text-sm font-medium px-3 py-1.5 rounded-md transition-colors no-underline inline-flex items-center justify-center',
        })
      );
    } else {
      items.push(
        tray.text('Manifest URL not configured', {
          style: { fontSize: '12px', color: 'rgb(248,113,113)' },
        })
      );
    }

    return tray.stack({ items, gap: 2 });
  }
}
