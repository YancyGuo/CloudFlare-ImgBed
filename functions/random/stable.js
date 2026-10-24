/**
 * Rendezvous selection: stable for an unchanged candidate pool, independent of
 * index order. Adding/removing a file only changes seeds whose winner changes.
 * This v1 non-cryptographic hash must stay fixed to preserve existing covers.
 * No per-article records or image copies are written.
 */
export function selectStableFile(records, articleId) {
    const prefix = hashPart(2166136261, articleId + '\0');
    let selected = null;
    let highest = -1;

    for (const record of records) {
        const score = finishHash(hashPart(prefix, record.name));
        if (score > highest || (score === highest && record.name < selected.name)) {
            selected = record;
            highest = score;
        }
    }

    return selected;
}

function hashPart(hash, text) {
    for (let i = 0; i < text.length; i++) {
        hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    }
    return hash >>> 0;
}

function finishHash(hash) {
    hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
    return (hash ^ (hash >>> 16)) >>> 0;
}
