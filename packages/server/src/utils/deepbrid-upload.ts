import {
  assessDeepbridArchiveVolumes,
  classifyDeepbridUploadFile,
  isDeepbridArchiveName,
  type DeepbridUploadInfo,
} from '@aiostreams/core';

/** Safe profile dashboard projection; provider URLs and raw error strings stay private. */
export function projectDeepbridUploadDetails(upload: DeepbridUploadInfo) {
  const files = upload.files.map((file) => {
    const assessment = classifyDeepbridUploadFile(file);
    return {
      name: file.name.slice(0, 500),
      size: Number.isFinite(file.size) && file.size > 0 ? file.size : undefined,
      sizeHuman: file.sizeHuman.slice(0, 80),
      kind: isDeepbridArchiveName(file.name)
        ? 'archive'
        : assessment.status === 'candidate'
          ? 'video-candidate'
          : 'other',
      status: assessment.status,
      reason: assessment.reason,
    };
  });
  const archiveAssessment = assessDeepbridArchiveVolumes(upload.files);

  return {
    id: upload.id,
    title: upload.title.slice(0, 500),
    files,
    archive: {
      status: archiveAssessment.incomplete
        ? 'incomplete'
        : archiveAssessment.hasArchives
          ? 'not-verified'
          : 'not-assessed',
      missingVolumeNumbers: archiveAssessment.missingVolumeNumbers,
      unreachableArchiveCount: archiveAssessment.unreachableArchiveCount,
    },
  } as const;
}

/** Folder resolution returns metadata only; signed provider URLs stay private. */
export function projectDeepbridFolderFiles(
  files: readonly import('@aiostreams/core').DeepbridFolderFile[]
) {
  return files.slice(0, 500).map((file) => ({
    name: file.name.slice(0, 500),
    size: Number.isFinite(file.size) && file.size > 0 ? file.size : undefined,
    sizeHuman: file.sizeHuman.slice(0, 80),
    playableCandidate: file.playableCandidate,
    status: file.status,
    reason: file.reason,
  }));
}
