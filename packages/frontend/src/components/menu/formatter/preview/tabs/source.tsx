import { PreviewInput } from '../state';
import { FieldNote, TextField } from '../fields';

export function SourceTab({
  input,
  patch,
}: {
  input: PreviewInput;
  patch: (partial: Partial<PreviewInput>) => void;
}) {
  return (
    <div className="space-y-4">
      <TextField
        field="stream.filename"
        label="Filename"
        always
        value={input.filename}
        onChange={(filename) => patch({ filename })}
      />
      <TextField
        field="stream.folderName"
        label="Folder name"
        always
        value={input.folderName}
        onChange={(folderName) => patch({ folderName })}
      />
      <FieldNote>
        Both names are parsed and merged exactly as they are for a real stream.
        Everything they produce is on the Parsed File tab, where you can also
        override it.
      </FieldNote>
    </div>
  );
}
