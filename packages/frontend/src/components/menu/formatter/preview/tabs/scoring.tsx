import { PreviewInput } from '../state';
import {
  AdvancedFields,
  FieldGrid,
  ListField,
  NumberField,
  SwitchField,
  SwitchRow,
  TextField,
} from '../fields';

const ADVANCED = ['stream.rankedRegexMatched', 'stream.rseMatched'];

export function ScoringTab({
  input,
  patch,
}: {
  input: PreviewInput;
  patch: (partial: Partial<PreviewInput>) => void;
}) {
  return (
    <div className="space-y-4">
      <FieldGrid cols={3}>
        <TextField
          field="stream.regexMatched"
          label="Regex matched"
          value={input.regexMatched}
          onChange={(regexMatched) => patch({ regexMatched })}
          placeholder="e.g. 2160p"
        />
        <NumberField
          field="stream.regexScore"
          label="Regex score"
          value={input.regexScore}
          onChange={(regexScore) => patch({ regexScore })}
          min={-1_000_000}
          max={1_000_000}
          step={5}
        />
        <NumberField
          field="stream.nRegexScore"
          label="Highest regex score"
          help="Normalises stream.nRegexScore"
          value={input.maxRegexScore}
          onChange={(maxRegexScore) => patch({ maxRegexScore })}
          min={1}
          step={10}
        />
        <TextField
          field="stream.seMatched"
          label="Stream expression matched"
          value={input.seMatched}
          onChange={(seMatched) => patch({ seMatched })}
          placeholder="e.g. high-quality"
        />
        <NumberField
          field="stream.seScore"
          label="Stream expression score"
          value={input.seScore}
          onChange={(seScore) => patch({ seScore })}
          min={-1_000_000}
          max={1_000_000}
          step={10}
        />
        <NumberField
          field="stream.nSeScore"
          label="Highest expression score"
          help="Normalises stream.nSeScore"
          value={input.maxSeScore}
          onChange={(maxSeScore) => patch({ maxSeScore })}
          min={1}
          step={25}
        />
      </FieldGrid>

      <SwitchRow>
        <SwitchField
          field="stream.seadex"
          label="SeaDex"
          value={input.seadex}
          onChange={(seadex) => patch({ seadex })}
        />
        <SwitchField
          field="stream.seadexBest"
          label="SeaDex best"
          disabled={!input.seadex}
          value={input.seadex && input.seadexBest}
          onChange={(seadexBest) => patch({ seadexBest })}
        />
      </SwitchRow>

      <AdvancedFields fields={ADVANCED}>
        <FieldGrid cols={2}>
          <ListField
            field="stream.rankedRegexMatched"
            label="Ranked regexes matched"
            value={input.rankedRegexMatched}
            onChange={(rankedRegexMatched) => patch({ rankedRegexMatched })}
            placeholder="2160p, HDR10+, REMUX"
          />
          <ListField
            field="stream.rseMatched"
            label="Ranked expressions matched"
            value={input.rseMatched}
            onChange={(rseMatched) => patch({ rseMatched })}
            placeholder="high-quality, best-match"
          />
        </FieldGrid>
      </AdvancedFields>
    </div>
  );
}
