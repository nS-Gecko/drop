import prisma from "~/server/internal/db/database";
import { defineDropTask, wrapTaskContext } from "..";
import { libraryManager } from "../../library";
import notificationSystem from "~/server/internal/notifications";
import { castManifest } from "../../library/manifest/utils";

/**
 * Detects file changes inside ALREADY-IMPORTED version folders.
 *
 * Drop's stock behaviour only flags a game as having a pending update
 * when a brand new "version-N" folder appears next to an existing one
 * (see LibraryManager.fetchUnimportedGameVersions, which diffs folder
 * *names* against GameVersion.versionPath). Editing files in place
 * inside an already-imported version folder is invisible to Drop.
 *
 * This task closes that gap: for every locally-imported version, it
 * does a cheap comparison (filenames + sizes, via the existing
 * FilesystemProvider.versionReaddir/peekFile) between what's on disk
 * now and what was stored in GameVersion.fileList at import time.
 *
 * On drift, it does NOT touch the existing (already-served) version -
 * clients may be mid-download or diffing against its checksums. It
 * generates a full droplet manifest for the current on-disk state and
 * stores it as an UnimportedGameVersion, which is exactly the model
 * Drop already uses for "pending version, ready to import" - so the
 * existing "Drop has detected a new version to import" admin
 * notification and library UI pick it up with zero further changes.
 */
export default defineDropTask({
  buildId: () => `import:detect-drift:${new Date().toISOString()}`,
  name: "Detect changed game files",
  acls: ["system:import:version:read"],
  taskGroup: "import:detect-drift",
  async run({ progress, logger, addAction }) {
    const versions = await prisma.gameVersion.findMany({
      where: {
        versionPath: { not: null },
      },
      select: {
        versionId: true,
        versionPath: true,
        displayName: true,
        fileList: true,
        dropletManifest: true,
        gameId: true,
        game: {
          select: {
            libraryId: true,
            libraryPath: true,
            mName: true,
          },
        },
      },
    });

    logger.info(`Scanning ${versions.length} version(s) for file drift`);

    let i = 0;
    const progressStep = versions.length > 0 ? 100 / versions.length : 100;

    for (const version of versions) {
      const displayName = `${version.game.mName} ${version.displayName ?? version.versionPath}`;
      const min = i * progressStep;
      const max = (i + 1) * progressStep;
      i++;

      const library = await libraryManager.getLibrary(version.game.libraryId);
      if (!library || !version.versionPath) {
        continue;
      }

      // Already-pending drift for this version? Don't duplicate.
      const alreadyPending = await prisma.unimportedGameVersion.findFirst({
        where: {
          gameId: version.gameId,
          versionName: { startsWith: `${version.versionPath}@drift-` },
        },
      });
      if (alreadyPending) {
        progress(max);
        continue;
      }

      let currentFiles: string[];
      try {
        currentFiles = await library.versionReaddir(
          version.game.libraryPath,
          version.versionPath,
        );
      } catch (e) {
        logger.warn(`Could not read files for ${displayName}: ${e}`);
        progress(max);
        continue;
      }

      const storedFiles = version.fileList ?? [];
      const storedSizes = buildSizeMap(version.dropletManifest);
      const drifted = await hasDrifted(
        library,
        version.game.libraryPath,
        version.versionPath,
        storedFiles,
        storedSizes,
        currentFiles,
      );

      if (!drifted) {
        progress(max);
        continue;
      }

      logger.info(`Drift detected for ${displayName}, generating manifest`);

      const taskContext = wrapTaskContext(
        { progress, logger, addAction },
        { min, max, prefix: `re-check ${displayName}` },
      );

      const manifest = await library.generateDropletManifest(
        version.game.libraryPath,
        version.versionPath,
        taskContext.progress,
        (value) => taskContext.logger.info(value),
      );

      await prisma.unimportedGameVersion.create({
        data: {
          gameId: version.gameId,
          // Suffix keeps this readable in the admin UI while doubling
          // as the de-dup marker checked above.
          versionName: `${version.versionPath}@drift-${Date.now()}`,
          manifest,
          fileList: currentFiles,
        },
      });

      notificationSystem.systemPush({
        nonce: `version-drift-${version.gameId}-${version.versionPath}`,
        title: `Files changed for '${version.game.mName}'`,
        description: `Drop detected file changes in an already-imported version ('${version.displayName ?? version.versionPath}'). Review and import the update from the library page.`,
        actions: [`View|/admin/library/${version.gameId}`],
        acls: ["system:import:version:read"],
      });

      progress(max);
    }

    logger.info("Done");
    progress(100);
  },
});

/**
 * Extracts a filename -> byte length map from an already-stored
 * droplet manifest (V2Manifest.chunks[*].files[*].{filename,length}).
 * No new data has to be stored to get this - it's already computed
 * and persisted at import time.
 */
function buildSizeMap(rawManifest: unknown): Map<string, number> {
  const sizes = new Map<string, number>();
  try {
    const manifest = castManifest(rawManifest as never);
    for (const chunk of Object.values(manifest.chunks)) {
      for (const file of chunk.files) {
        sizes.set(file.filename, (sizes.get(file.filename) ?? 0) + file.length);
      }
    }
  } catch {
    // Manifest missing/unreadable - fall back to filename-only diffing.
  }
  return sizes;
}

/**
 * Drift check: filename set diff first (free - already fetched), then
 * a real byte-size comparison against the manifest already stored for
 * this version. A same-named file whose content was replaced (the
 * common "I overwrote the build in place" case) will very reliably
 * show a different length, without needing a full content re-hash.
 * Content-identical-length replacements are the one case this can't
 * catch cheaply - the manual "Re-check integrity" admin action still
 * covers that if ever needed.
 */
async function hasDrifted(
  library: ReturnType<typeof libraryManager.getLibrary>,
  libraryPath: string,
  versionPath: string,
  storedFiles: string[],
  storedSizes: Map<string, number>,
  currentFiles: string[],
): Promise<boolean> {
  if (!library) return false;

  const storedSet = new Set(storedFiles);
  const currentSet = new Set(currentFiles);

  if (storedSet.size !== currentSet.size) return true;
  for (const f of currentSet) {
    if (!storedSet.has(f)) return true;
  }

  // Same filenames present on both sides - compare real sizes.
  // Sampling instead of checking every file keeps this cheap on
  // libraries with many large games; tune SAMPLE_LIMIT if you'd
  // rather always check everything.
  const SAMPLE_LIMIT = 200;
  const toCheck = currentFiles.slice(0, SAMPLE_LIMIT);

  for (const file of toCheck) {
    const expected = storedSizes.get(file);
    if (expected === undefined) continue; // no baseline, can't compare

    const stat = await library.peekFile(libraryPath, versionPath, file);
    if (!stat) return true; // file vanished mid-check -> treat as drift
    if (stat.size !== expected) return true;
  }

  return false;
}
