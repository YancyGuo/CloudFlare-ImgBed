import assert from 'node:assert/strict';
import { loadFunction } from './helpers/loadFunction.js';
import * as adaptive from '../functions/random/adaptive.js';
import { selectStableFile } from '../functions/random/stable.js';

describe('stable article covers', () => {
    let records, settings, route, previousCaches, previousRandom, reads, fetches;

    beforeEach(async () => {
        records = ['a.webp', 'b.webp', 'c.webp', 'd.webp'].map(name => ({
            name: 'covers/' + name, FileType: 'image/webp', Width: 1920, Height: 1080,
        }));
        settings = { randomImageAPI: { enabled: true, allowedDir: 'covers' } };
        reads = 0;
        fetches = 0;
        previousCaches = globalThis.caches;
        previousRandom = Math.random;
        globalThis.caches = { default: { async match() {
            reads++;
            return new Response(JSON.stringify(records));
        } } };
        route = await loadFunction('functions/random/index.js', {
            ...adaptive, selectStableFile, fetchOthersConfig: async () => settings,
        }, { fetch: async () => {
            fetches++;
            return new Response('source-image', { headers: { 'Content-Type': 'image/webp' } });
        } });
    });

    afterEach(() => {
        Math.random = previousRandom;
        if (previousCaches === undefined) delete globalThis.caches;
        else globalThis.caches = previousCaches;
    });

    const request = query => new Request('https://test/random?dir=covers&' + query);
    const call = req => route.onRequest({ request: req, env: {} });

    it('is independent of random state and index ordering', async () => {
        const expected = selectStableFile(records, 'article-1').name;
        Math.random = () => 0;
        const first = await call(request('mode=stable&t=article-1&type=url'));
        records.reverse();
        Math.random = () => 0.999;
        const second = await call(request('mode=stable&t=article-1&type=url'));
        assert.deepEqual(await first.json(), { url: 'https://test/file/' + expected });
        assert.deepEqual(await second.json(), { url: 'https://test/file/' + expected });
        assert.equal(first.headers.get('Cache-Control'), 'public, max-age=86400');
    });

    it('does not remap existing winners when unselected files are removed', () => {
        for (let i = 0; i < 100; i++) {
            const seed = 'article-' + i;
            const chosen = selectStableFile(records, seed);
            assert.equal(selectStableFile([chosen], seed).name, chosen.name);
            const rest = records.filter(file => file !== chosen);
            assert.ok(rest.includes(selectStableFile(rest, seed)));
        }
    });

    it('only changes to a newly added file and distributes article IDs', () => {
        const added = { name: 'covers/new.webp' };
        const winners = new Set();
        for (let i = 0; i < 128; i++) {
            const seed = 'article-' + i;
            const before = selectStableFile(records, seed);
            winners.add(before.name);
            const after = selectStableFile([...records, added], seed);
            assert.ok(after === before || after === added);
        }
        assert.equal(winners.size, records.length);
        assert.equal(selectStableFile([], 'article'), null);
    });

    it('redirects images to the selected file without fetching or buffering it', async () => {
        const response = await call(request('mode=stable&t=article-1&type=img'));
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('Location'), 'https://test/file/' + selectStableFile(records, 'article-1').name);
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
        assert.equal(response.headers.get('Cache-Control'), 'public, max-age=86400');
        assert.equal(await response.text(), '');
        assert.equal(fetches, 0);
    });

    it('preserves the existing relative, full-URL and text response forms', async () => {
        const path = '/file/' + selectStableFile(records, 'article-1').name;
        assert.deepEqual(await (await call(request('mode=stable&t=article-1'))).json(), { url: path });
        assert.equal(await (await call(request('mode=stable&t=article-1&type=url&form=text'))).text(), 'https://test' + path);
    });

    it('rejects missing, empty and excessively long article IDs without reading the index', async () => {
        for (const suffix of ['', '&t=', '&t=%20%20', '&t=' + 'x'.repeat(257)]) {
            const response = await call(request('mode=stable' + suffix));
            assert.equal(response.status, 400);
            assert.equal(response.headers.get('Cache-Control'), 'no-store');
        }
        assert.equal(reads, 0);
    });

    it('keeps random mode random even when the existing t parameter is present', async () => {
        Math.random = () => 0;
        const first = await call(request('t=article-1&type=url'));
        Math.random = () => 0.999;
        const second = await call(request('t=article-1&type=url'));
        assert.notDeepEqual(await first.json(), await second.json());
        assert.equal(first.headers.get('Cache-Control'), null);
    });

    it('preserves the original random image response', async () => {
        const response = await call(request('type=img'));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Type'), 'image/webp');
        assert.equal(await response.text(), 'source-image');
        assert.equal(fetches, 1);
    });

    it('enforces disabled and directory restrictions before selecting any file', async () => {
        settings.randomImageAPI.enabled = false;
        assert.equal((await call(request('mode=stable&t=article'))).status, 403);
        settings.randomImageAPI.enabled = true;
        assert.equal((await call(new Request('https://test/random?dir=covers-extra&mode=stable&t=article'))).status, 403);
        assert.equal(reads, 0);
    });

    it('selects only eligible types and orientations and handles an empty pool', async () => {
        records.push({ name: 'covers/video.mp4', FileType: 'video/mp4' });
        records.push({ name: 'covers/portrait.webp', FileType: 'image/webp', Width: 600, Height: 1000 });
        const response = await call(request('mode=stable&t=article&orientation=portrait&type=url'));
        assert.deepEqual(await response.json(), { url: 'https://test/file/covers/portrait.webp' });
        records = [{ name: 'covers/video.mp4', FileType: 'video/mp4' }];
        const empty = await call(request('mode=stable&t=article&type=img'));
        assert.equal(empty.status, 200);
        assert.deepEqual(await empty.json(), {});
        assert.equal(empty.headers.get('Cache-Control'), null);
    });

    it('does not share auto-orientation responses between clients', async () => {
        const response = await call(request('mode=stable&t=article&orientation=auto&type=url'));
        assert.equal(response.headers.get('Cache-Control'), 'private, max-age=86400');
        assert.match(response.headers.get('Vary'), /User-Agent/);
    });

    it('encodes file names without allowing them to become query parameters', async () => {
        records = [{ name: 'covers/图片 ?#.webp', FileType: 'image/webp' }];
        const response = await call(request('mode=stable&t=article&type=img'));
        const location = new URL(response.headers.get('Location'));
        assert.equal(location.search, '');
        assert.equal(location.hash, '');
        assert.equal(decodeURIComponent(location.pathname), '/file/covers/图片 ?#.webp');
    });
});
