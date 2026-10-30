import { load } from 'cheerio';
import { fetchSchedulePage } from './schedule-page.mjs';
import { normalizeName } from './cinema-registry.mjs';

export const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const validTime = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

export function parseAtmoviesSchedule(html, cinema) {
  const $ = load(html);
  const heading = $('h2').map((_, element) => $(element).text().trim()).get();
  if (!heading.some(name => cinema.sourceNames.some(expected => normalizeName(name) === normalizeName(expected)))) throw new Error('Wrong cinema');
  const block = $('#theaterShowtimeBlock');
  if (!block.length) {
    const poster = $('.theaterboard img[src]').first().attr('src');
    if (poster) {
      const url = new URL(poster, cinema.sourceUrl);
      if (url.origin === 'https://www.atmovies.com.tw' && url.pathname.startsWith('/movie/homeimages/A1showtime/')) {
        return { kind: 'image_only', date: null, publishedDates: [], movies: [], imageUrl: url.href };
      }
    }
    throw new Error('Unknown schedule structure');
  }
  const label = block.prevAll('h3').first().text().trim();
  const match = /^(\d{4})\/(\d{2})\/(\d{2})\s*[（(][日一二三四五六][）)]$/.exec(label);
  const date = match && `${match[1]}-${match[2]}-${match[3]}`;
  if (block.length !== 1 || !date || !validDate(date)) throw new Error('Unknown date structure');
  const publishedDates = new Set([date]);
  $('a[href]').each((_, element) => {
    const url = new URL($(element).attr('href'), cinema.sourceUrl);
    if (url.origin !== 'https://www.atmovies.com.tw') return;
    const prefix = `/showtime/${cinema.theaterCode}/${cinema.areaCode}/`;
    const stamp = url.pathname.startsWith(prefix) && /^(\d{4})(\d{2})(\d{2})\/$/.exec(url.pathname.slice(prefix.length));
    if (stamp) {
      const day = `${stamp[1]}-${stamp[2]}-${stamp[3]}`;
      if (validDate(day)) publishedDates.add(day);
    }
  });
  // 官網使用重複 id，因此用屬性選擇器讀取所有電影／版本區塊。
  const entries = block.find('[id="theaterShowtimeTable"]');
  if (!entries.length) throw new Error('No readable showtimes');
  const movies = [];
  entries.each((_, element) => {
    const entry = $(element);
    const titleLink = entry.children('.filmTitle').find('a').first();
    const title = titleLink.text().replace(/\s+/g, ' ').trim();
    const timeList = entry.children('li').eq(1).children('ul').last();
    const version = timeList.children('.filmVersion').text().replace(/\s+/g, ' ').trim() || '來源未標示版本';
    if (!title || !timeList.length) throw new Error('Missing movie or time list');
    const times = timeList.children('li:not(.filmVersion):not(.theaterElse)').map((_, li) => $(li).text().normalize('NFKC').trim()).get();
    if (!times.length || times.some(time => !validTime(time))) throw new Error('Unknown showtime format');
    const url = new URL(titleLink.attr('href'), cinema.sourceUrl);
    const detailUrl = url.origin === 'https://www.atmovies.com.tw' && /^\/movie\/[a-z0-9]+\/$/.test(url.pathname) ? url.href : null;
    const previous = movies.find(movie => movie.title === title && movie.version === version);
    if (previous) previous.times = [...new Set([...previous.times, ...times])].sort();
    else movies.push({ title, version, detailUrl, times: [...new Set(times)].sort() });
  });
  return { date, publishedDates: [...publishedDates].sort(), movies };
}

export class AtmoviesSource {
  constructor({ fetcher = fetchSchedulePage, now = () => new Date() } = {}) {
    this.fetcher = fetcher; this.now = now; this.cache = new Map(); this.inflight = new Map(); this.retryAt = new Map();
  }
  async page(cinema, date, today) {
    const url = cinema.sourceUrl + (date === today ? '' : `${date.replaceAll('-', '')}/`);
    const now = this.now().valueOf();
    // 限制長期運行時的快取大小；失敗的 key 亦會定期清理。
    for (const [key, value] of this.cache) if (now - value.fetched >= 300_000) this.cache.delete(key);
    for (const [key, value] of this.retryAt) if (value <= now) this.retryAt.delete(key);
    if (this.cache.has(url)) return this.cache.get(url);
    if (this.inflight.has(url)) return this.inflight.get(url);
    if (this.retryAt.has(url)) throw new Error('Retry later');
    this.retryAt.set(url, now + 30_000);
    const promise = (async () => {
      const response = await this.fetcher(url, {
        headers: { 'User-Agent': 'MovieCompanionLearningBot/0.2', accept: 'text/html' },
        signal: AbortSignal.timeout(8_000), redirect: 'error',
      });
      if (!response.ok) throw new Error(`Schedule HTTP ${response.status}`);
      const html = await response.text();
      if (html.length > 2_000_000) throw new Error('Page too large');
      const result = { ...parseAtmoviesSchedule(html, cinema), fetched: this.now().valueOf(), sourceUrl: url };
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(url, result);
      return result;
    })();
    this.inflight.set(url, promise);
    try { return await promise; } finally { this.inflight.delete(url); }
  }
  async schedule(cinema, { date, afterTime = '', onlyUpcoming = false, local }) {
    const base = {
      cinemaId: cinema.id, cinema: cinema.name, brand: cinema.brand, provider: 'atmovies',
      source: '開眼電影網（第三方時刻表）', sourceUrl: cinema.sourceUrl, bookingUrl: cinema.bookingUrl,
      websiteFromDirectory: cinema.websiteFromDirectory || false,
      date, afterTime, onlyUpcoming,
      notice: '場次由開眼電影網整理，非影城官方 API；來源可能延遲或未涵蓋所有版本。實際場次與售票以影城為準。',
    };
    try {
      const page = await this.page(cinema, date, local.date);
      const meta = { ...base, sourceUrl: page.sourceUrl, fetchedAt: new Date(page.fetched).toISOString(), publishedDates: page.publishedDates };
      if (page.kind === 'image_only') return { ...meta, status: 'links_only', imageUrl: page.imageUrl,
        message: '這個來源只有圖片時刻表，尚未自動擷取日期與場次。請開啟來源原圖或影城網站確認，不代表沒有放映。' };
      if (page.date !== date) return { ...meta, status: 'not_published' };
      const movies = page.movies.map(movie => ({ ...movie, times: movie.times.filter(time => time >= afterTime) })).filter(movie => movie.times.length)
        .sort((a, b) => a.times[0].localeCompare(b.times[0]));
      return { ...meta, status: movies.length ? 'ok' : 'no_upcoming', movies };
    } catch {
      return { ...base, status: 'unavailable', message: '時刻表暫時無法讀取或格式已變更，請到來源或影城網站確認。' };
    }
  }
}
