/**
 * The runbook body of record is the Document in DataHub, and this module is
 * what makes that true rather than aspirational.
 *
 * Until now the Document was written once at capture and never read again. A
 * data steward could correct a step inside DataHub and the edit was invisible
 * here; the next write from this side would have clobbered it. Reconciliation
 * is a three-way compare over content digests, the same normalized sha256 the
 * round-trip receipt uses:
 *
 *   - the digest of the catalog document at last sync (the base),
 *   - the digest of the local rendering at last sync,
 *   - and both sides as they stand now.
 *
 * Catalog moved, local didn't → the catalog wins. The edited body is pulled
 * onto the handoff verbatim and the sync base advances; nothing is written to
 * DataHub. Local moved, catalog didn't → safe to push, and the push is
 * compare-and-set: it re-reads the catalog first and refuses if anything
 * changed since the base, so a document edited in DataHub between the check
 * and the write still cannot be overwritten. Both moved → a conflict, named
 * with both digests, for a person. There is no force flag.
 */

import { datahubGraphQL, gmsReachable } from "./datahub-graphql";
import { documentDigest, readDocument, verifyDocumentRoundTrip } from "./document-readback";
import { handoffToMarkdown, saveHandoff } from "./handoff-store";
import { isDemoMode } from "./mcp";
import type { Handoff } from "./types";

export type SyncStatus =
  | "in-sync"
  | "local-ahead"
  | "catalog-ahead"
  | "conflict"
  | "unwritten"
  | "catalog-missing"
  | "unreachable";

export interface SyncReceipt {
  runbookId: string;
  documentUrn?: string;
  status: SyncStatus;
  localDigest?: string;
  catalogDigest?: string;
  /** The base both sides are compared against: the state at last sync. */
  base?: { catalog?: string; local?: string };
  action: "none" | "pulled" | "pushed" | "refused";
  detail: string;
  at: string;
}

/** Same normalization the round-trip receipt applies before digesting. */
const normalize = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();
const digestOf = (s: string) => documentDigest(normalize(s));

/**
 * The pure three-way decision, factored out so it can be tested to exhaustion
 * without a catalog. `base` values may be undefined for handoffs written
 * before sync digests existed; an unknown base is treated as "the catalog
 * copy is the base", which makes the first reconcile of an old handoff adopt
 * the catalog state rather than declare a conflict nobody caused.
 */
export function syncStatusOf(input: {
  catalogDigest: string;
  localDigest: string;
  baseCatalog?: string;
  baseLocal?: string;
}): Extract<SyncStatus, "in-sync" | "local-ahead" | "catalog-ahead" | "conflict"> {
  const baseCatalog = input.baseCatalog ?? input.catalogDigest;
  const baseLocal = input.baseLocal ?? input.localDigest;
  const catalogMoved = input.catalogDigest !== baseCatalog;
  const localMoved = input.localDigest !== baseLocal;
  if (catalogMoved && localMoved) return "conflict";
  if (catalogMoved) return "catalog-ahead";
  if (localMoved) return "local-ahead";
  return "in-sync";
}

const UPDATE_DOCUMENT_CONTENTS = `
  mutation updateDocumentContents($input: UpdateDocumentContentsInput!) { updateDocumentContents(input: $input) }
`;

/**
 * The human act of having folded a pulled catalog edit into the runbook. Only
 * this clears the pulled body, and only clearing it unblocks pushes.
 */
export function markPullFolded(handoff: Handoff): void {
  if (!handoff.datahub) return;
  delete handoff.datahub.pulledBody;
  delete handoff.datahub.pulledAt;
  saveHandoff(handoff);
}

const receipt = (runbookId: string, partial: Omit<SyncReceipt, "runbookId" | "at">): SyncReceipt => ({
  runbookId,
  at: new Date().toISOString(),
  ...partial,
});

/**
 * Compare the handoff against its Document in DataHub, and when the catalog is
 * ahead, accept it: the edited body lands on the handoff verbatim
 * (`datahub.pulledBody`) and the sync base advances. Pull is the default
 * because "authoritative" has to mean something when nobody is watching — the
 * unattended sweep runs this too.
 */
export async function reconcileHandoff(handoff: Handoff, options: { pull?: boolean } = {}): Promise<SyncReceipt> {
  const { pull = true } = options;
  const id = handoff.id;

  if (isDemoMode() || !(await gmsReachable())) {
    return receipt(id, { action: "none", status: "unreachable", detail: "No live catalog to reconcile against." });
  }

  const documentUrn = handoff.datahub?.documentUrn;
  const localDigest = digestOf(handoffToMarkdown(handoff));
  if (!documentUrn) {
    return receipt(id, {
      action: "none",
      status: "unwritten",
      localDigest,
      detail: "This runbook has never been written to DataHub, so there is no body of record yet.",
    });
  }

  const doc = await readDocument(documentUrn);
  if (!doc) {
    return receipt(id, {
      action: "none",
      status: "catalog-missing",
      documentUrn,
      localDigest,
      detail: "DataHub no longer returns the document body. It may have been deleted; that is a human question.",
    });
  }

  const catalogDigest = digestOf(doc.content);
  const base = {
    catalog: handoff.datahub?.syncedCatalogDigest ?? handoff.datahub?.roundTrip?.writtenDigest,
    local: handoff.datahub?.syncedLocalDigest ?? handoff.datahub?.roundTrip?.writtenDigest,
  };
  const status = syncStatusOf({ catalogDigest, localDigest, baseCatalog: base.catalog, baseLocal: base.local });

  if (status === "catalog-ahead" && pull) {
    handoff.datahub = {
      ...handoff.datahub!,
      syncedCatalogDigest: catalogDigest,
      syncedLocalDigest: base.local ?? localDigest,
      pulledBody: doc.content,
      pulledAt: new Date().toISOString(),
    };
    saveHandoff(handoff);
    return receipt(id, {
      action: "pulled",
      status,
      documentUrn,
      localDigest,
      catalogDigest,
      base,
      detail:
        `The document was edited in DataHub (${base.catalog} → ${catalogDigest}) and the catalog wins: the edited ` +
        `body is stored on the handoff verbatim. The structured steps predate it until someone folds the edit in.`,
    });
  }

  const details: Record<typeof status, string> = {
    "in-sync": "The catalog document and the local runbook agree with the last sync on both sides.",
    "local-ahead": "The local runbook changed and the catalog document has not. Safe to push.",
    "catalog-ahead": `The document was edited in DataHub (${base.catalog} → ${catalogDigest}). Run a pull to accept it.`,
    conflict:
      `Both sides moved since the last sync: catalog ${base.catalog} → ${catalogDigest}, local ` +
      `${base.local} → ${localDigest}. Neither side is overwritten; a person merges this.`,
  };
  return receipt(id, { action: "none", status, documentUrn, localDigest, catalogDigest, base, detail: details[status] });
}

/**
 * Push the local runbook body into its DataHub document, compare-and-set on
 * the content digest. The catalog is re-read immediately before the write,
 * and any digest other than the sync base refuses the push — including the
 * conflict case, and including a base we never recorded. Overwriting a
 * document somebody edited in DataHub is the one thing this module exists to
 * make impossible.
 */
export async function pushHandoffDocument(handoff: Handoff): Promise<SyncReceipt> {
  const id = handoff.id;
  if (isDemoMode() || !(await gmsReachable())) {
    return receipt(id, { action: "refused", status: "unreachable", detail: "No live catalog to push to." });
  }

  /*
   * A pulled body that nobody has folded in blocks every push. Without this,
   * "pull then push" would be a two-step overwrite of the very edit the pull
   * accepted: the base advances at pull time, the compare-and-set passes, and
   * the steward's words leave the catalog by the polite route. Folding the
   * edit into the runbook (and saying so with markPullFolded) is a human act,
   * and the push waits for it.
   */
  if (handoff.datahub?.pulledBody) {
    return receipt(id, {
      action: "refused",
      status: "local-ahead",
      documentUrn: handoff.datahub.documentUrn,
      detail:
        `A body edited in DataHub was pulled at ${handoff.datahub.pulledAt} and has not been folded into the ` +
        `runbook. Pushing now would overwrite that edit by the back door. Fold it in, mark it folded, then push.`,
    });
  }
  const documentUrn = handoff.datahub?.documentUrn;
  const markdown = handoffToMarkdown(handoff);
  const localDigest = digestOf(markdown);
  if (!documentUrn) {
    return receipt(id, {
      action: "refused",
      status: "unwritten",
      localDigest,
      detail: "No document URN to push to. Save the runbook to DataHub first.",
    });
  }

  const doc = await readDocument(documentUrn);
  if (!doc) {
    return receipt(id, {
      action: "refused",
      status: "catalog-missing",
      documentUrn,
      localDigest,
      detail: "DataHub no longer returns the document; pushing blind could resurrect something somebody deleted.",
    });
  }

  const catalogDigest = digestOf(doc.content);
  const base = {
    catalog: handoff.datahub?.syncedCatalogDigest ?? handoff.datahub?.roundTrip?.writtenDigest,
    local: handoff.datahub?.syncedLocalDigest ?? handoff.datahub?.roundTrip?.writtenDigest,
  };
  if (base.catalog !== catalogDigest) {
    return receipt(id, {
      action: "refused",
      status: syncStatusOf({ catalogDigest, localDigest, baseCatalog: base.catalog, baseLocal: base.local }),
      documentUrn,
      localDigest,
      catalogDigest,
      base,
      detail:
        `The catalog document is at ${catalogDigest}, and the last sync saw ${base.catalog ?? "nothing"}. Somebody ` +
        `edited it in DataHub; pushing would overwrite them. Reconcile first.`,
    });
  }

  const updated = await datahubGraphQL<{ updateDocumentContents: boolean }>(UPDATE_DOCUMENT_CONTENTS, {
    input: { urn: documentUrn, contents: { text: markdown } },
  });
  if (updated.errors?.length || !updated.data?.updateDocumentContents) {
    return receipt(id, {
      action: "refused",
      status: "local-ahead",
      documentUrn,
      localDigest,
      catalogDigest,
      base,
      detail: `updateDocumentContents failed: ${updated.errors?.map((e) => e.message).join("; ") || "returned false"}.`,
    });
  }

  const roundTrip = await verifyDocumentRoundTrip(documentUrn, markdown);
  handoff.datahub = {
    ...handoff.datahub!,
    saved: true,
    roundTrip,
    syncedCatalogDigest: localDigest,
    syncedLocalDigest: localDigest,
  };
  delete handoff.datahub.pulledBody;
  delete handoff.datahub.pulledAt;
  saveHandoff(handoff);
  return receipt(id, {
    action: "pushed",
    status: "in-sync",
    documentUrn,
    localDigest,
    catalogDigest: localDigest,
    base,
    detail:
      `Pushed ${localDigest} over ${catalogDigest} after confirming the catalog still matched the sync base, and ` +
      `read it back: ${roundTrip.matches ? "the catalog returns the pushed body byte for byte" : `read-back mismatch — ${roundTrip.error ?? "digests differ"}`}.`,
  });
}
