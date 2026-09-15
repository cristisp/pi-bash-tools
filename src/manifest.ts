import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { flowDirFor, flowReportsDir, PREDIGEST_SUBDIR } from './flow.ts';
import { sanitizeReviewScope } from './delegation.ts';
import { LEDGER_NAME } from './ledger.ts';
import { sanitizeSegment } from './registry-store.ts';
import type {
	DelegationContext,
	KnownManifestRef,
	ReadManifest,
	ReadReference,
	RepositoryStateStatus,
	ValidationReference,
} from './types.ts';

const MAX_MANIFEST_ITEMS = 100;
const MAX_MANIFEST_ITEM_LENGTH = 512;
const MAX_KNOWN_REFS = 24;
const MAX_REF_LENGTH = 200;
const REFS_SUBDIR = 'refs';
const VERDICTS = new Set(['passed', 'failed', 'incomplete']);
const STATE_STATUSES = new Set(['matches', 'mismatch', 'unreadable']);
const REF_KINDS = new Set(['verify', 'read']);

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

function knownRefsDir(flowId: string): string {
	return path.join(flowDirFor(flowId), PREDIGEST_SUBDIR, REFS_SUBDIR);
}

function knownRefsPath(flowId: string, delegationId: string): string {
	return path.join(knownRefsDir(flowId), `${sanitizeSegment(delegationId)}.json`);
}

/**
 * Projects an observed validation reference into the manifest vocabulary. Refs minted under a
 * different flow provenance, or with ambiguous provenance, are not resolvable from this flow's
 * children and are dropped instead of advertised.
 */
function knownRefOf(reference: ValidationReference, flowId: string): KnownManifestRef | undefined {
	if (reference.flowIdConflict) return undefined;
	if (reference.flowId && reference.flowId !== flowId) return undefined;
	const ref = typeof reference.ref === 'string' ? reference.ref.trim() : '';
	if (!ref || ref.length > MAX_REF_LENGTH) return undefined;
	return {
		ref,
		...(reference.verdict ? { verdict: reference.verdict } : {}),
		reused: reference.reused,
		...(reference.repositoryStateStatus
			? { repositoryStateStatus: reference.repositoryStateStatus }
			: {}),
		...(reference.head ? { head: reference.head } : {}),
		...(reference.stateDigest ? { stateDigest: reference.stateDigest } : {}),
	};
}

/**
 * Projects an observed read_batch reference into the manifest vocabulary. Read refs carry no
 * verdict, so only refs whose minting call published into this flow are advertised; anything else
 * cannot resolve from a sibling lookup and would only waste a confirm attempt.
 */
function knownReadRefOf(reference: ReadReference): KnownManifestRef | undefined {
	if (reference.flowIdConflict) return undefined;
	if (reference.publication !== 'published') return undefined;
	const ref = reference.ref.trim();
	if (!ref || ref.length > MAX_REF_LENGTH) return undefined;
	return { ref, kind: 'read', reused: reference.reused };
}

/**
 * Persists the validation refs one completed turn minted or resolved into the flow's predigest
 * namespace, so later read manifests can carry them as structured resolution hints. Best-effort:
 * an unwritable flow store must never fail a delegation.
 */
export function recordKnownRefs(input: {
	flowId: string | undefined;
	delegationId: string;
	refs: ValidationReference[];
	readRefs?: ReadReference[];
	at?: number;
}): void {
	if (!input.flowId) return;
	const refs = [
		...input.refs.map((reference) => knownRefOf(reference, input.flowId!)),
		...(input.readRefs?.map((reference) => knownReadRefOf(reference)) ?? []),
	]
		.filter((entry) => entry !== undefined)
		.slice(0, MAX_KNOWN_REFS);
	if (refs.length === 0) return;
	const record = { v: 1, flowId: input.flowId, at: input.at ?? Date.now(), refs };
	const target = knownRefsPath(input.flowId, input.delegationId);
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
		fs.renameSync(temporary, target);
	} catch {
		try {
			fs.unlinkSync(temporary);
		} catch {}
	}
}

function parsedKnownRef(value: unknown): KnownManifestRef | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const entry = value as Record<string, unknown>;
	const ref = typeof entry.ref === 'string' ? entry.ref.trim() : '';
	if (!ref || ref.length > MAX_REF_LENGTH || typeof entry.reused !== 'boolean') return undefined;
	let kind: KnownManifestRef['kind'];
	if (entry.kind !== undefined) {
		if (!(typeof entry.kind === 'string' && REF_KINDS.has(entry.kind))) return undefined;
		kind = entry.kind === 'read' ? 'read' : undefined;
	}
	if (
		entry.verdict !== undefined &&
		!(typeof entry.verdict === 'string' && VERDICTS.has(entry.verdict))
	)
		return undefined;
	if (
		entry.repositoryStateStatus !== undefined &&
		!(
			typeof entry.repositoryStateStatus === 'string' &&
			STATE_STATUSES.has(entry.repositoryStateStatus)
		)
	)
		return undefined;
	for (const field of ['head', 'stateDigest'] as const) {
		if (entry[field] !== undefined && typeof entry[field] !== 'string') return undefined;
	}
	// Read refs carry no verdict or state identity: the confirm lookup is the source of truth.
	if (kind === 'read') return { ref, kind, reused: entry.reused as boolean };
	return {
		ref,
		...(typeof entry.verdict === 'string'
			? { verdict: entry.verdict as KnownManifestRef['verdict'] }
			: {}),
		reused: entry.reused,
		...(typeof entry.repositoryStateStatus === 'string'
			? { repositoryStateStatus: entry.repositoryStateStatus as RepositoryStateStatus }
			: {}),
		...(typeof entry.head === 'string' ? { head: entry.head } : {}),
		...(typeof entry.stateDigest === 'string' ? { stateDigest: entry.stateDigest } : {}),
	};
}

/** Reads every persisted turn's refs for a flow, newest observation last, deduplicated by ref. */
function knownRefsFor(flowId: string): KnownManifestRef[] {
	type Dated = KnownManifestRef & { at: number };
	const dated: Dated[] = [];
	try {
		for (const name of fs.readdirSync(knownRefsDir(flowId)).toSorted()) {
			try {
				const parsed = JSON.parse(fs.readFileSync(path.join(knownRefsDir(flowId), name), 'utf8'));
				const at = typeof parsed?.at === 'number' ? parsed.at : 0;
				if (!Array.isArray(parsed?.refs)) continue;
				for (const entry of parsed.refs) {
					const known = parsedKnownRef(entry);
					if (known) dated.push({ ...known, at });
				}
			} catch {}
		}
	} catch {
		return [];
	}
	const latest = new Map<string, Dated>();
	for (const entry of dated) {
		const existing = latest.get(entry.ref);
		if (!existing || entry.at >= existing.at) latest.set(entry.ref, entry);
	}
	const merged = [...latest.values()].toSorted((a, b) => a.at - b.at);
	return merged.slice(-MAX_KNOWN_REFS).map(({ at: _at, ...ref }) => ref);
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
	const knownRefs = delegation.flowId ? knownRefsFor(delegation.flowId) : [];
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
		...(knownRefs.length ? { knownRefs } : {}),
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
		'Refs under knownRefs are resolution hints from prior turns: confirm each by looking it up with its minting tool instead of rereading prior reports for evidence, and treat a failed, stale, or not-found lookup as NOT_RUN.',
		'Verify refs (vr_) resolve through a verify ref lookup; read refs (rr_) resolve through a read_batch ref lookup.',
	].join('\n');
}
