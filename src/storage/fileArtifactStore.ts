import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact } from '../provider/index.js';
import type { ArtifactStore, BlobStore } from './artifactStore.js';
import { artifactObjectKey, makeArtifactStore } from './artifactStore.js';
import { isNotFound } from './fsErrors.js';
import type { VersionId } from './types.js';

// The local-directory backend: one immutable html file per version under `dir`.
// Because makeArtifactStore mints a fresh VersionId per put, the filename is new every
// time and a write never lands on an existing file — immutability needs no guard here.
export const makeFileArtifactStore = (dir: string): ArtifactStore => {
  const pathOf = (versionId: VersionId): string => join(dir, artifactObjectKey(versionId));
  const backend: BlobStore = {
    async write(versionId: VersionId, artifact: Artifact): Promise<void> {
      await mkdir(dir, { recursive: true });
      await writeFile(pathOf(versionId), artifact.html, 'utf8');
    },
    async read(versionId: VersionId): Promise<Artifact | undefined> {
      try {
        return { html: await readFile(pathOf(versionId), 'utf8') };
      } catch (err) {
        if (isNotFound(err)) return undefined;
        throw err;
      }
    },
  };
  return makeArtifactStore(backend);
};
