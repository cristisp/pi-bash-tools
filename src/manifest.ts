import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { flowDirFor, flowReportsDir, PREDIGEST_SUBDIR } from './flow.ts';
import { sanitizeReviewScope } from './delegation.ts';
import { LEDGER_NAME } from './ledger.ts';
import { sanitizeSegment } from './registry-store.ts';
import type { DelegationContext, ReadManifest } from './types.ts';

const MAX_MANIFEST_ITEMS = 100;
const MAX_MANIFEST_ITEM_LENGTH = 512;

function reportPaths(flowId: string | undefined): string[] {
	if (!flowId) return [];
	try {
		return fs
			.readdirSync(flowReportsDir(flowId))
			.filter((name) => name.endsWith('.md'))
			.toSorted()
			.map((name) => path.join(flowReportsDir(flowId), name))
			.filter((reportPath) => reportPath.length <= MAX_MANIFEST_ITEM_LENGTH)
			.slice(0, MAX_MANIFEST_ITEMS);
	} catch {
		return [];
	}
}

function writeJsonAtomically(target: string, content: string): Promise<void> {
	const temporary = `${target}.${randomUUID()}.tmp`;
	return fs.promises
		.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
		.then(() => fs.promises.rename(temporary, target))
		.catch(async (error) => {
			try {
				await fs.promises.unlink(temporary);
			} catch {}
			throw error;
		});
}

export function buildReadManifest(delegation: DelegationContext): ReadManifest {
	const surfacePath =
		delegation.flowId &&
		delegation.reviewSurfacePath ===
			path.join(flowDirFor(delegation.flowId), PREDIGEST_SUBDIR, 'review-surface.md')
			? delegation.reviewSurfacePath
			: undefined;
	const artifactPaths = [
		...(surfacePath ? [surfacePath] : []),
		...(delegation.flowId ? [path.join(flowDirFor(delegation.flowId), LEDGER_NAME)] : []),
	].filter((artifactPath) => artifactPath.length <= MAX_MANIFEST_ITEM_LENGTH);
	const priorReports = reportPaths(delegation.flowId);
	const establishedEvidence = [
		...(surfacePath ? [`The shared review surface is captured at ${surfacePath}.`] : []),
		...(priorReports.length
			? [`${priorReports.length} prior role report(s) are available in the flow report directory.`]
			: []),
	].filter((evidence) => evidence.length <= MAX_MANIFEST_ITEM_LENGTH);
	const doNotReread = surfacePath ? [surfacePath] : [];
	const allowedPaths = sanitizeReviewScope(delegation.scope)?.paths ?? [];
	return {
		v: 1,
		...(delegation.flowId ? { flowId: delegation.flowId } : {}),
		artifactPaths: artifactPaths.slice(0, MAX_MANIFEST_ITEMS),
		...(delegation.dirtyPaths?.length
			? { dirtyPaths: delegation.dirtyPaths.slice(0, MAX_MANIFEST_ITEMS) }
			: {}),
		allowedPaths: allowedPaths
			.filter((scopePath) => scopePath.length <= MAX_MANIFEST_ITEM_LENGTH)
			.slice(0, MAX_MANIFEST_ITEMS),
		priorReports,
		establishedEvidence: establishedEvidence.slice(0, MAX_MANIFEST_ITEMS),
		doNotReread: doNotReread.filter(
			(artifactPath) => artifactPath.length <= MAX_MANIFEST_ITEM_LENGTH,
		),
	};
}

export async function writeReadManifest(
	dir: string,
	delegation: DelegationContext,
): Promise<{ path: string; manifest: ReadManifest }> {
	const manifestPath = path.join(dir, 'read-manifest.json');
	const persistedPath = delegation.flowId
		? path.join(
				flowDirFor(delegation.flowId),
				'predigest',
				'manifests',
				`${sanitizeSegment(delegation.delegationId)}.json`,
			)
		: undefined;
	const manifest: ReadManifest = {
		...buildReadManifest(delegation),
		manifestPath,
		...(persistedPath ? { persistedPath } : {}),
	};
	const content = `${JSON.stringify(manifest, null, 2)}\n`;
	try {
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(manifestPath, content, { encoding: 'utf8', mode: 0o600 });
		if (persistedPath) {
			await fs.promises.mkdir(path.dirname(persistedPath), { recursive: true });
			await writeJsonAtomically(persistedPath, content);
		}
	} catch (error) {
		try {
			await fs.promises.unlink(manifestPath);
		} catch {}
		throw error;
	}
	return { path: manifestPath, manifest };
}

export function manifestGuidance(manifestPath: string): string {
	return [
		'## Read manifest',
		`Read the bounded manifest before reacquiring repository context: ${manifestPath}`,
		'Use its artifact and prior-report references, and avoid reads listed under doNotReread unless required by a documented evidence gap.',
	].join('\n');
}
