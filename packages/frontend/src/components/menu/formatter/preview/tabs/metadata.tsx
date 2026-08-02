import * as constants from '../../../../../../../core/src/utils/constants';
import { PreviewInput, PreviewMetadata } from '../state';
import {
  AdvancedFields,
  FieldGrid,
  ListField,
  NumberField,
  SelectField,
  SwitchField,
  SwitchRow,
  TextField,
} from '../fields';

const ADVANCED = [
  'metadata.titles',
  'metadata.yearEnd',
  'metadata.episodeRuntime',
  'metadata.absoluteEpisode',
  'metadata.relativeAbsoluteEpisode',
  'metadata.originalLanguage',
  'metadata.country',
  'metadata.latestSeason',
  'metadata.daysSinceRelease',
  'metadata.daysSinceFirstAired',
  'metadata.daysSinceLastAired',
  'metadata.hasNextEpisode',
  'metadata.daysUntilNextEpisode',
  'metadata.anilistId',
  'metadata.malId',
  'metadata.hasSeaDex',
];

export function MetadataTab({
  input,
  patch,
}: {
  input: PreviewInput;
  patch: (partial: Partial<PreviewInput>) => void;
}) {
  const metadata = input.metadata;
  const set = (partial: Partial<PreviewMetadata>) =>
    patch({ metadata: { ...metadata, ...partial } });

  const queryType = metadata.type
    ? metadata.isAnime
      ? `anime.${metadata.type}`
      : metadata.type
    : '';

  return (
    <div className="space-y-4">
      <FieldGrid cols={3}>
        <SelectField
          field="metadata.type"
          label="Type"
          value={metadata.type}
          onChange={(type) => set({ type })}
          options={constants.TYPES.map((type) => ({
            label: constants.TYPE_LABELS[type],
            value: type,
          }))}
        />
        <TextField
          field="metadata.queryType"
          label="Query type"
          help="Derived from type and anime"
          disabled
          value={queryType}
          onChange={() => undefined}
        />
        <TextField
          field="metadata.title"
          label="Title"
          value={metadata.title}
          onChange={(title) => set({ title })}
        />
        <NumberField
          field="metadata.year"
          label="Year"
          value={metadata.year}
          onChange={(year) => set({ year })}
          min={0}
        />
        <NumberField
          field="metadata.season"
          label="Season"
          value={metadata.season}
          onChange={(season) => set({ season })}
          min={0}
        />
        <NumberField
          field="metadata.episode"
          label="Episode"
          value={metadata.episode}
          onChange={(episode) => set({ episode })}
          min={0}
        />
        <ListField
          field={['metadata.episodeTitle', 'metadata.episodeTitles']}
          label="Episode titles"
          help="Comma separated; the first is metadata.episodeTitle"
          value={metadata.episodeTitles}
          onChange={(episodeTitles) => set({ episodeTitles })}
        />
        <ListField
          field="metadata.genres"
          label="Genres"
          value={metadata.genres}
          onChange={(genres) => set({ genres })}
        />
        <NumberField
          field="metadata.runtime"
          label="Runtime (minutes)"
          value={metadata.runtime}
          onChange={(runtime) => set({ runtime })}
          min={0}
        />
      </FieldGrid>

      <SwitchRow>
        <SwitchField
          field="metadata.isAnime"
          label="Anime"
          value={metadata.isAnime}
          onChange={(isAnime) => set({ isAnime })}
        />
      </SwitchRow>

      <AdvancedFields fields={ADVANCED}>
        <FieldGrid cols={3}>
          <ListField
            field="metadata.titles"
            label="Titles"
            value={metadata.titles}
            onChange={(titles) => set({ titles })}
          />
          <NumberField
            field="metadata.yearEnd"
            label="End year"
            value={metadata.yearEnd}
            onChange={(yearEnd) => set({ yearEnd })}
            min={0}
          />
          <NumberField
            field="metadata.episodeRuntime"
            label="Episode runtime (minutes)"
            value={metadata.episodeRuntime}
            onChange={(episodeRuntime) => set({ episodeRuntime })}
            min={0}
          />
          <NumberField
            field="metadata.absoluteEpisode"
            label="Absolute episode"
            value={metadata.absoluteEpisode}
            onChange={(absoluteEpisode) => set({ absoluteEpisode })}
            min={0}
          />
          <NumberField
            field="metadata.relativeAbsoluteEpisode"
            label="Relative absolute episode"
            value={metadata.relativeAbsoluteEpisode}
            onChange={(relativeAbsoluteEpisode) =>
              set({ relativeAbsoluteEpisode })
            }
            min={0}
          />
          <TextField
            field="metadata.originalLanguage"
            label="Original language"
            help="Also resolves the 'Original' entry in your language preferences"
            value={metadata.originalLanguage}
            onChange={(originalLanguage) => set({ originalLanguage })}
          />
          <TextField
            field="metadata.country"
            label="Country"
            value={metadata.country}
            onChange={(country) => set({ country })}
          />
          <NumberField
            field="metadata.latestSeason"
            label="Latest season"
            value={metadata.latestSeason}
            onChange={(latestSeason) => set({ latestSeason })}
            min={0}
          />
          <NumberField
            field="metadata.daysSinceRelease"
            label="Days since release"
            value={metadata.daysSinceRelease}
            onChange={(daysSinceRelease) => set({ daysSinceRelease })}
            min={0}
          />
          <NumberField
            field="metadata.daysSinceFirstAired"
            label="Days since first aired"
            value={metadata.daysSinceFirstAired}
            onChange={(daysSinceFirstAired) => set({ daysSinceFirstAired })}
            min={0}
          />
          <NumberField
            field="metadata.daysSinceLastAired"
            label="Days since last aired"
            value={metadata.daysSinceLastAired}
            onChange={(daysSinceLastAired) => set({ daysSinceLastAired })}
            min={0}
          />
          <NumberField
            field="metadata.daysUntilNextEpisode"
            label="Days until next episode"
            value={metadata.daysUntilNextEpisode}
            onChange={(daysUntilNextEpisode) => set({ daysUntilNextEpisode })}
            min={0}
          />
          <NumberField
            field="metadata.anilistId"
            label="AniList ID"
            value={metadata.anilistId}
            onChange={(anilistId) => set({ anilistId })}
            min={0}
          />
          <NumberField
            field="metadata.malId"
            label="MyAnimeList ID"
            value={metadata.malId}
            onChange={(malId) => set({ malId })}
            min={0}
          />
        </FieldGrid>
        <SwitchRow>
          <SwitchField
            field="metadata.hasNextEpisode"
            label="Has next episode"
            value={metadata.hasNextEpisode}
            onChange={(hasNextEpisode) => set({ hasNextEpisode })}
          />
          <SwitchField
            field="metadata.hasSeaDex"
            label="Has SeaDex entry"
            value={metadata.hasSeaDex}
            onChange={(hasSeaDex) => set({ hasSeaDex })}
          />
        </SwitchRow>
      </AdvancedFields>
    </div>
  );
}
