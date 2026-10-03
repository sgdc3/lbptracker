/**
 * Opening a level published on Bonsai, the community server LBP is played on
 * now.
 *
 * Bonsai (`lbp.lbpbonsai.com`) is the official instance of Refresh
 * (<https://github.com/LittleBigRefresh/Refresh>), the custom server that
 * replaced Mm's after 2021. Unlike the Internet Archive it is alive: levels are
 * still being published to it, and its public API v3 serves a level's metadata,
 * a search over every level, and every resource by its SHA-1.
 *
 * ✔ **Measured, 2026-10-04: every route used here answers any origin.**
 * Refresh's `CrossOriginMiddleware` puts `Access-Control-Allow-Origin: *` on
 * everything under `/api/v3`, and the deployed server does: a search, a level by
 * id, a 404, an asset download and its `OPTIONS` preflight all carry the header.
 * That is the fact the whole shape turns on. The archive route is a hash and
 * not a search *only* because zaprit.fish sends no CORS headers; Bonsai does, so
 * here the page searches it directly and **still needs no server of its own**.
 *
 * ❗ **The level is named by its number**, the one in its page's address
 * (`/level/2488`), which is what a reader copies off Bonsai's site. It is
 * resolved to a root hash at every open rather than pinned to one: a creator
 * who republishes a level keeps the number and gets a new hash, and a link to a
 * song should follow the level. Thing uids survive a republish, so `seq` does.
 */

/** The instance. One, until there is a reason for a second. */
export const BONSAI_HOST = 'https://lbp.lbpbonsai.com';
const API = `${BONSAI_HOST}/api/v3`;

/** A level's page on Bonsai's own site, for a reader to go and look at. */
export const bonsaiLevelPage = (id: number): string => `${BONSAI_HOST}/level/${id}`;

/** A level's metadata, root hash included. Answers 404 with a JSON error. */
export const bonsaiLevelUrl = (id: number): string => `${API}/levels/id/${id}`;

/** The level whose root resource is this hash. */
export const bonsaiLevelByHashUrl = (sha1: string): string => `${API}/levels/hash/${sha1}`;

/**
 * A resource's raw bytes, by SHA-1: the same bytes the game downloads.
 *
 * ⚠️ **Rate-limited: 70 per 60 s per address, then 30 s of `429`** --
 * `RawAssetRequestAmount` and `RequestBlockDuration` in Refresh's
 * `ResourceApiEndpoints.cs`, read from the source, not provoked against the
 * live server. The walk's cap below exists because of it.
 */
export const bonsaiAssetUrl = (sha1: string): string => `${API}/assets/${sha1}/download`;

/** A texture as a PNG, converted by the server. Only for a SHA-1, not a GUID. */
export const bonsaiIconUrl = (sha1: string): string => `${API}/assets/${sha1}/image`;

/**
 * How many results a page asks for: the most the server allows (`GetPageData`
 * clamps `count` to 100).
 *
 * ❗ **As many as possible, because the order is ours.** Bonsai sorts a search
 * by `CoolRating` and nothing else -- `SearchForLevels` matches
 * `ILIKE '%query%'` on the title OR the description and then orders by rating,
 * and no parameter changes it -- so the page re-ranks what comes back
 * (`rankLevels`), and a ranking can only promote what it was given. One page of
 * 100 holds the whole answer to most searches: "music gallery" is 17 levels,
 * "sequencer" 31, "sonic" 133.
 */
export const SEARCH_PAGE = 100;

/**
 * The search, over the games whose levels can hold a song this reader opens.
 *
 * ❗ **`game=lbp2&game=lbp3`, and the filter is measured, not decorative.**
 * LBP1 and LBP PSP have no Music Sequencer at all. LBP Vita has one, but six of
 * six Vita music levels off Bonsai (revision `0x3e2`) fail in the reader with
 * "the world Thing carried no WORLD part", so offering them would be offering
 * an error. Repeating `game` is how the API takes several (`FromApiRequest` in
 * `LevelFilterSettings.cs`), checked against the live server: "music" gives 475
 * levels unfiltered and 435 with `lbp2`, `lbp3` and `vita`.
 *
 * ⚠️ **`skip` is one-based.** `GetPageData` subtracts one from it, and the
 * answer's `nextPageIndex` is already in that numbering (`11` after a first
 * page of 10), so the next page is asked for with exactly the number the last
 * one returned. See `readSearch` for what it says on the last page.
 */
export function bonsaiSearchUrl(query: string, skip?: number): string {
  return listUrl('search', { query }, skip);
}

/** A level list route, over the two games and a page of `SEARCH_PAGE`. */
function listUrl(route: string, fields: Record<string, string>, skip?: number): string {
  const params = new URLSearchParams({ ...fields, count: String(SEARCH_PAGE) });
  params.append('game', 'lbp2');
  params.append('game', 'lbp3');
  if (skip !== undefined) params.set('skip', String(skip));
  return `${API}/levels/${route}?${params}`;
}

/**
 * A registered user, looked up by name **whatever its capitals**: `users/name/`
 * is `GetUserByUsername(id, caseSensitive: false)`, and `subyuko` answers with
 * `Subyuko`. It answers 404 for a name nobody registered.
 *
 * ⚠️ **There is no user search to do this with.** `users/search` exists in
 * Refresh but answers 404 on Bonsai, which does not permit listing users
 * (`PermitShowingOnlineUsers`), so a creator is found by their whole name only.
 */
export const bonsaiUserUrl = (name: string): string => `${API}/users/name/${encodeURIComponent(name)}`;

/**
 * The levels a creator published, or with `!` in front of the name, the levels
 * other people reuploaded with that creator as `originalPublisher`.
 *
 * ⚠️ **Both want the name exactly, capitals and all**: `GetUserByUsername` is
 * case-sensitive on this route, so `Subyuko` gives 19 levels and `subyuko` a
 * 404; `!FattyMcIntosh` gives 11 reuploads and `!fattymcintosh` none. That is
 * why `bonsaiUserUrl` is asked first. The `!` is Refresh's `SystemPrefix`, and a
 * name behind it is matched against `OriginalPublisher` (`GetLevelsByUser`).
 */
export const bonsaiByUserUrl = (username: string, skip?: number): string =>
  listUrl('byUser', { username }, skip);

/**
 * Whether a query could be somebody's name, and is worth asking about.
 *
 * Refresh's own rule (`UsernameRegex` in `CommonPatterns.cs`): 3 to 16 letters,
 * digits, hyphens and underscores -- PSN's, without the first-letter rule. A
 * query with a space in it is not a name, and asking would spend two of the
 * fifty level lists Bonsai allows in four minutes for nothing.
 */
export const looksLikeName = (query: string): boolean => /^[A-Za-z0-9_-]{3,16}$/.test(query);

/** The username out of a `users/name/` answer's `data`, or nothing. */
export function readBonsaiUser(raw: unknown): string | undefined {
  const name = isRecord(raw) ? text(raw.username) : undefined;
  return name && looksLikeName(name) ? name : undefined;
}

/** Lowercase, accents gone, anything that is not a letter or a digit a single space. */
const fold = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * How well a level answers a query: higher is better.
 *
 * The title decides, because the server also matches the description and that
 * is where most of the noise comes from: "sequencer" finds 31 levels and 18 of
 * them only say it in their description. A creator's whole name ranks just
 * under a title that starts with the query.
 */
export function levelScore(query: string, level: Pick<BonsaiLevel, 'title' | 'publisher' | 'original'>): number {
  const q = fold(query);
  if (q === '') return 0;
  const title = fold(level.title);
  const padded = ` ${title} `;
  if (title === q) return 100;
  if (title.startsWith(q)) return 90;
  if ([level.publisher, level.original].some((name) => name !== undefined && fold(name) === q)) return 85;
  if (padded.includes(` ${q} `)) return 80;
  if (title.includes(q)) return 70;
  const words = q.split(' ');
  if (words.every((word) => padded.includes(` ${word}`))) return 60;
  if (words.some((word) => title.includes(word))) return 30;
  return 10;
}

/**
 * The levels in order of how well they answer the query, Bonsai's own order
 * (by rating) breaking ties -- so a page of equally good titles still reads
 * best-rated first.
 */
export function rankLevels(query: string, levels: readonly BonsaiLevel[]): BonsaiLevel[] {
  return levels
    .map((level, at) => ({ level, at, score: levelScore(query, level) }))
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map((ranked) => ranked.level);
}

/** The line over the results: what was found, by title and by creator. */
export function searchSummary(
  query: string,
  total: number,
  author?: { readonly name: string; readonly count: number },
): string {
  const levels = (n: number) => `${n} level${n === 1 ? '' : 's'}`;
  const byTitle = total > 0 ? `${levels(total)} for “${query}”` : '';
  const byAuthor = author && author.count > 0 ? `${levels(author.count)} by ${author.name}` : '';
  if (byTitle && byAuthor) return `${byAuthor}, and ${byTitle}`;
  return byAuthor || byTitle || `nothing on Bonsai for “${query}”`;
}

/** Refresh's `TokenGame`, as far as a reader needs to tell them apart. */
const GAMES: Record<number, string> = {
  0: 'LBP1', 1: 'LBP2', 2: 'LBP3', 3: 'LBP Vita', 4: 'LBP PSP', 6: 'beta',
};

/** The games that have no Music Sequencer at all, so no level of theirs can hold a song. */
const SONGLESS = new Set([0, 4]);

/** A level as the panel needs it: validated, because all of it came over the network. */
export interface BonsaiLevel {
  readonly id: number;
  readonly title: string;
  /** The creator: the original one for a reupload, which is who wrote the songs. */
  readonly author: string;
  /** The account that published it on Bonsai. */
  readonly publisher?: string;
  /** Who made it, when it is a reupload that says so (`originalPublisher`). */
  readonly original?: string;
  readonly sha1: string;
  readonly game: number;
  readonly hearts: number;
  /** A SHA-1, when the icon is a user resource; a GUID icon has no image route. */
  readonly icon?: string;
}

export const gameName = (game: number): string => GAMES[game] ?? `game ${game}`;

/** Why a level cannot hold a song, before anything is downloaded; or nothing. */
export function songlessWhy(level: Pick<BonsaiLevel, 'game' | 'title'>): string | undefined {
  return SONGLESS.has(level.game)
    ? `${gameName(level.game)} has no music sequencer, so “${level.title}” holds no songs`
    : undefined;
}

const SHA1 = /^[0-9a-f]{40}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Is this a level number Refresh could have handed out? A positive `int`. */
export const isLevelId = (n: number): boolean => Number.isInteger(n) && n > 0 && n <= 0x7fffffff;

/**
 * One level out of an API answer, or `undefined` when it is not one.
 *
 * ⚠️ **Validated, not trusted.** The hash goes into a fetch URL and the title
 * onto the screen; a level whose root is not a SHA-1 is not one we can open.
 */
export function readBonsaiLevel(raw: unknown): BonsaiLevel | undefined {
  if (!isRecord(raw)) return undefined;
  const id = raw.levelId;
  const sha1 = text(raw.rootLevelHash);
  if (typeof id !== 'number' || !isLevelId(id) || !sha1 || !SHA1.test(sha1)) return undefined;
  const publisher = (isRecord(raw.publisher) ? text(raw.publisher.username) : undefined) || undefined;
  const original = text(raw.originalPublisher) || undefined;
  const icon = text(raw.iconHash);
  return {
    id,
    title: text(raw.title)?.trim() || `level ${id}`,
    author: original ?? publisher ?? 'somebody',
    publisher,
    original,
    sha1: sha1.toLowerCase(),
    game: typeof raw.gameVersion === 'number' ? raw.gameVersion : -1,
    hearts: typeof raw.hearts === 'number' ? raw.hearts : 0,
    icon: icon && SHA1.test(icon) ? icon.toLowerCase() : undefined,
  };
}

/**
 * What the API wraps everything in: `{ success, data }`, or `{ success: false,
 * error: { message } }`, with a `listInfo` beside `data` for a list.
 */
export function readAnswer(raw: unknown): { data: unknown; error?: string; next?: number; total?: number } {
  if (!isRecord(raw)) return { data: undefined, error: 'Bonsai answered something that is not its API' };
  if (raw.success !== true) {
    const message = isRecord(raw.error) ? text(raw.error.message) : undefined;
    return { data: undefined, error: message ?? 'Bonsai refused the request' };
  }
  const info = isRecord(raw.listInfo) ? raw.listInfo : undefined;
  return {
    data: raw.data,
    next: typeof info?.nextPageIndex === 'number' ? info.nextPageIndex : undefined,
    total: typeof info?.totalItems === 'number' ? info.totalItems : undefined,
  };
}

/** A page of search results: the levels in it that could be read, and where the next one starts. */
export function readSearch(raw: unknown): { levels: BonsaiLevel[]; next?: number; total: number; error?: string } {
  const answer = readAnswer(raw);
  if (answer.error) return { levels: [], total: 0, error: answer.error };
  const levels = Array.isArray(answer.data)
    ? answer.data.map(readBonsaiLevel).filter((l): l is BonsaiLevel => l !== undefined)
    : [];
  const total = answer.total ?? levels.length;
  // ⚠️ **The last page says `nextPageIndex: 0`**, measured on "music gallery"
  // (19 levels, pages of 10: `11`, then `0`). Zero is also a valid-looking
  // `skip`, and asking for it would start the list again.
  const next = answer.next !== undefined && answer.next > 0 && answer.next <= total
    ? answer.next
    : undefined;
  return { levels, next, total };
}

/**
 * What a reader typed into the box: a level, by number, link or hash, or
 * words to search for.
 *
 * ❗ **A bare number is a level, not a search** -- a decision: it is what the
 * end of a level's address is, and a level titled with nothing but digits can
 * still be found by searching with a word of its description beside them.
 *
 * A hash is accepted because it is what the archive box takes and what a
 * `?level=` link carries; Bonsai can look a level up by its root resource.
 */
export type BonsaiPaste =
  | { readonly kind: 'id'; readonly id: number }
  | { readonly kind: 'hash'; readonly sha1: string }
  | { readonly kind: 'words'; readonly query: string }
  | { readonly kind: 'empty' };

export function readBonsaiPaste(typed: string): BonsaiPaste {
  const trimmed = typed.trim();
  if (trimmed === '') return { kind: 'empty' };
  // A level's page: `/level/2488`, possibly with more after it. Matched on the
  // path alone, so the same link off a mirror or a newer site still reads.
  const page = /\/levels?\/(\d+)(?:[/?#]|$)/i.exec(trimmed);
  const bare = /^#?(\d+)$/.exec(trimmed);
  const digits = page?.[1] ?? bare?.[1];
  if (digits !== undefined) {
    const id = Number(digits);
    if (isLevelId(id)) return { kind: 'id', id };
  }
  if (SHA1.test(trimmed)) return { kind: 'hash', sha1: trimmed.toLowerCase() };
  return { kind: 'words', query: trimmed };
}
