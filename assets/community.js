/* 本科集 · 评分评论（共享 Appwrite 后端，多站点共用）
 * 数据隔离：本站所有 recipe_id 一律带前缀 benkeji:
 * 仅含公开 Project ID，无任何密钥。
 */
(function () {
  'use strict';

  var PROJECT_ID = '6af2c92a00134f1f4cf5';
  var ENDPOINT = 'https://sgp.cloud.appwrite.io/v1';
  var DB_ID = 'jzs';
  var PREFIX = 'benkeji:';

  var LS_SESSION = 'jzs-session';
  var LS_MY = 'jzs-my-ratings';
  var LS_NAME = 'jzs-name';
  var LS_CACHE = 'jzs-stats-cache';
  var CACHE_TTL = 10 * 60 * 1000; // 10 分钟
  var PAGE_LIMIT = 100;
  var MAX_DOCS = 5000;

  var stats = {};          // id -> {avg, count, comments}
  var sessionPromise = null;
  var dialogId = null;

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 忽略 */ }
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function qstr(queries) {
    return queries.map(function (q) {
      return 'queries[]=' + encodeURIComponent(JSON.stringify(q));
    }).join('&');
  }

  /* ---------- 会话（匿名，一人一票的 voter_id） ---------- */
  function readSession() {
    var s = lsGet(LS_SESSION);
    if (s && s.userId && s.secret && s.expire && new Date(s.expire).getTime() > Date.now() + 60000) return s;
    return null;
  }
  function createSession() {
    return fetch(ENDPOINT + '/account/sessions/anonymous', {
      method: 'POST',
      headers: { 'X-Appwrite-Project': PROJECT_ID, 'Content-Type': 'application/json' },
      body: '{}'
    }).then(function (res) {
      if (!res.ok) throw new Error('会话创建失败 ' + res.status);
      // 响应体 secret 为空，真正令牌在 X-Fallback-Cookies 头里（base64 原样使用）
      var fc = res.headers.get('X-Fallback-Cookies');
      var secret = '';
      if (fc) {
        try { secret = JSON.parse(fc)['a_session_' + PROJECT_ID] || ''; } catch (e) { /* 忽略 */ }
      }
      return res.json().then(function (body) {
        if (!secret) throw new Error('未取得会话令牌');
        var s = { userId: body.userId, secret: secret, expire: body.expire };
        lsSet(LS_SESSION, s);
        return s;
      });
    });
  }
  function ensureSession() {
    var s = readSession();
    if (s) return Promise.resolve(s);
    if (!sessionPromise) {
      sessionPromise = createSession().finally(function () { sessionPromise = null; });
    }
    return sessionPromise;
  }

  /* ---------- REST 封装 ---------- */
  function api(method, path, body, queries, retried) {
    var url = ENDPOINT + path + (queries && queries.length ? '?' + qstr(queries) : '');
    var s = readSession();
    var headers = { 'X-Appwrite-Project': PROJECT_ID, 'Content-Type': 'application/json' };
    if (s) headers['X-Appwrite-Session'] = s.secret; // 完整 base64，服务端自行解码
    return fetch(url, {
      method: method,
      headers: headers,
      body: body == null ? undefined : JSON.stringify(body)
    }).then(function (res) {
      if (res.status === 401 && !retried) {
        // 会话失效：重建一次再重试
        try { localStorage.removeItem(LS_SESSION); } catch (e) { /* 忽略 */ }
        return ensureSession().then(function () { return api(method, path, body, queries, true); });
      }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.message) || ('请求失败 ' + res.status));
          err.status = res.status;
          err.type = data && data.type;
          throw err;
        }
        return data;
      });
    });
  }

  /* ---------- 统计聚合 ---------- */
  function listAll(col, selectAttrs) {
    var out = [];
    function page(offset) {
      var queries = [
        { method: 'startsWith', attribute: 'recipe_id', values: [PREFIX] },
        { method: 'select', values: selectAttrs },
        { method: 'limit', values: [PAGE_LIMIT] },
        { method: 'offset', values: [offset] }
      ];
      return api('GET', '/databases/' + DB_ID + '/collections/' + col + '/documents', null, queries)
        .then(function (res) {
          var docs = res.documents || [];
          out = out.concat(docs);
          if (docs.length === PAGE_LIMIT && out.length < MAX_DOCS) return page(offset + PAGE_LIMIT);
          return out;
        });
    }
    return page(0);
  }
  function refreshStats(force) {
    if (!force) {
      var cache = lsGet(LS_CACHE);
      if (cache && cache.t && Date.now() - cache.t < CACHE_TTL && cache.stats) {
        stats = cache.stats;
        decorateCards(document);
        window.dispatchEvent(new CustomEvent('jzs-stats'));
      }
    }
    return Promise.all([
      listAll('ratings', ['recipe_id', 'stars']),
      listAll('comments', ['recipe_id'])
    ]).then(function (rs) {
      var agg = {};
      rs[0].forEach(function (d) {
        if (String(d.recipe_id).indexOf(PREFIX) !== 0) return;
        var a = agg[d.recipe_id] || (agg[d.recipe_id] = { sum: 0, count: 0, comments: 0 });
        a.sum += Number(d.stars) || 0; a.count += 1;
      });
      rs[1].forEach(function (d) {
        if (String(d.recipe_id).indexOf(PREFIX) !== 0) return;
        var a = agg[d.recipe_id] || (agg[d.recipe_id] = { sum: 0, count: 0, comments: 0 });
        a.comments += 1;
      });
      var next = {};
      Object.keys(agg).forEach(function (id) {
        var a = agg[id];
        next[id] = { avg: a.count ? a.sum / a.count : 0, count: a.count, comments: a.comments };
      });
      stats = next;
      lsSet(LS_CACHE, { t: Date.now(), stats: stats });
      decorateCards(document);
      window.dispatchEvent(new CustomEvent('jzs-stats'));
      return stats;
    }).catch(function () { /* 网络失败时保留缓存/占位，渐进增强 */ });
  }
  function getStats(id) { return stats[id] || null; }

  /* ---------- 卡片装饰 ---------- */
  function decorateCards(root) {
    (root || document).querySelectorAll('[data-rate]').forEach(function (el) {
      var id = el.getAttribute('data-rate');
      var st = stats[id];
      var html;
      if (st && st.count > 0) {
        html = '<span class="jr-stars" aria-hidden="true">★</span> <b>' + st.avg.toFixed(1) + '</b>' +
          '<span class="jr-meta">' + st.count + ' 人评分 · ' + st.comments + ' 条评论</span>';
      } else if (st && st.comments > 0) {
        html = '<span class="jr-stars jr-empty" aria-hidden="true">☆</span> 暂无评分' +
          '<span class="jr-meta">' + st.comments + ' 条评论</span>';
      } else {
        html = '<span class="jr-stars jr-empty" aria-hidden="true">☆</span> 暂无评分' +
          '<span class="jr-meta">点击打分评论</span>';
      }
      el.innerHTML = html;
      el.classList.add('jr-ready');
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', '评分与评论');
      if (!el.__jrBound) {
        el.__jrBound = true;
        el.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          openDialog(id, el.getAttribute('data-title') || '');
        });
        el.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDialog(id, el.getAttribute('data-title') || ''); }
        });
      }
    });
  }

  /* ---------- 我的评分 ---------- */
  function myRatings() { return lsGet(LS_MY) || {}; }
  function setMyRating(id, stars) {
    var m = myRatings(); m[id] = stars; lsSet(LS_MY, m);
  }
  function fetchMyVote(id) {
    return ensureSession().then(function (s) {
      return api('GET', '/databases/' + DB_ID + '/collections/ratings/documents', null, [
        { method: 'equal', attribute: 'recipe_id', values: [id] },
        { method: 'equal', attribute: 'voter_id', values: [s.userId] },
        { method: 'limit', values: [1] }
      ]).then(function (res) {
        var doc = (res.documents || [])[0];
        if (doc) { setMyRating(id, doc.stars); return { docId: doc.$id, stars: doc.stars }; }
        return null;
      });
    });
  }

  /* ---------- 评分写入（一人一票、可改、防竞态） ---------- */
  function rate(id, stars) {
    stars = Math.max(1, Math.min(5, Math.round(stars)));
    return ensureSession().then(function (s) {
      function findMine() {
        return api('GET', '/databases/' + DB_ID + '/collections/ratings/documents', null, [
          { method: 'equal', attribute: 'recipe_id', values: [id] },
          { method: 'equal', attribute: 'voter_id', values: [s.userId] },
          { method: 'limit', values: [1] }
        ]).then(function (res) { return (res.documents || [])[0] || null; });
      }
      function patch(docId) {
        return api('PATCH', '/databases/' + DB_ID + '/collections/ratings/documents/' + docId, { data: { stars: stars } });
      }
      function create() {
        return api('POST', '/databases/' + DB_ID + '/collections/ratings/documents', {
          documentId: 'unique()',
          data: { recipe_id: id, voter_id: s.userId, stars: stars },
          permissions: ['read("any")', 'update("user:' + s.userId + '")', 'delete("user:' + s.userId + '")']
        }).catch(function (err) {
          if (err.status === 409) {
            // 唯一索引冲突 / 连点竞态：回查已有票再改
            return findMine().then(function (doc) {
              if (!doc) throw err;
              return patch(doc.$id);
            });
          }
          throw err;
        });
      }
      return findMine().then(function (doc) { return doc ? patch(doc.$id) : create(); });
    }).then(function () {
      setMyRating(id, stars);
      return refreshStats(true);
    });
  }

  /* ---------- 评论 ---------- */
  function listComments(id) {
    return api('GET', '/databases/' + DB_ID + '/collections/comments/documents', null, [
      { method: 'equal', attribute: 'recipe_id', values: [id] },
      { method: 'orderDesc', attribute: '$createdAt' },
      { method: 'limit', values: [100] }
    ]).then(function (res) { return res.documents || []; });
  }
  function postComment(id, name, body) {
    name = (name || '').trim().slice(0, 20) || '匿名访客';
    body = (body || '').trim().slice(0, 500);
    if (!body) return Promise.reject(new Error('评论不能为空'));
    return ensureSession().then(function () {
      return api('POST', '/databases/' + DB_ID + '/collections/comments/documents', {
        documentId: 'unique()',
        data: { recipe_id: id, name: name, body: body },
        permissions: ['read("any")']
      });
    }).then(function (doc) {
      lsSet(LS_NAME, name === '匿名访客' ? '' : name);
      return refreshStats(true).then(function () { return doc; });
    });
  }

  /* ---------- 详情弹窗 ---------- */
  var overlay = null, panelTitle = null, communityBox = null;
  function buildOverlay() {
    overlay = document.createElement('div');
    overlay.className = 'jr-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML =
      '<div class="jr-panel">' +
      '  <div class="jr-head"><h3 class="jr-title"></h3><button class="jr-close" aria-label="关闭">✕</button></div>' +
      '  <div class="jr-body" data-community></div>' +
      '</div>';
    document.body.appendChild(overlay);
    panelTitle = overlay.querySelector('.jr-title');
    communityBox = overlay.querySelector('[data-community]');
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeDialog(); });
    overlay.querySelector('.jr-close').addEventListener('click', closeDialog);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay.classList.contains('open')) closeDialog(); });
  }
  function openDialog(id, title) {
    if (!overlay) buildOverlay();
    dialogId = id;
    panelTitle.textContent = title || '评分与评论';
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    renderDialog(id, communityBox);
  }
  function closeDialog() {
    if (!overlay) return;
    overlay.classList.remove('open');
    document.body.style.overflow = '';
    dialogId = null;
  }

  function starRow(current, interactive) {
    var h = '<div class="jr-starrow' + (interactive ? ' jr-interactive' : '') + '">';
    for (var i = 1; i <= 5; i++) {
      h += interactive
        ? '<button type="button" class="jr-star' + (i <= current ? ' on' : '') + '" data-star="' + i + '" aria-label="' + i + ' 星">★</button>'
        : '<span class="jr-star' + (i <= Math.round(current) ? ' on' : '') + '">★</span>';
    }
    return h + '</div>';
  }

  function renderDialog(id, container) {
    var st = stats[id] || { avg: 0, count: 0, comments: 0 };
    var mine = myRatings()[id] || 0;
    container.innerHTML =
      '<div class="jr-summary">' +
      (st.count > 0
        ? starRow(st.avg, false) + '<span class="jr-avg"><b>' + st.avg.toFixed(1) + '</b> 分 · ' + st.count + ' 人评分 · ' + st.comments + ' 条评论</span>'
        : '<span class="jr-avg">暂无评分，来打第一个分吧</span>') +
      '</div>' +
      '<div class="jr-mine"><span class="jr-mine-label">我的评分</span>' + starRow(mine, true) + '<span class="jr-mine-tip">一人一票，可随时修改</span></div>' +
      '<form class="jr-form">' +
      '  <input class="jr-name" type="text" maxlength="20" placeholder="昵称（可选，≤20 字）" autocomplete="off">' +
      '  <textarea class="jr-text" maxlength="500" rows="3" placeholder="写下你的评论（≤500 字）"></textarea>' +
      '  <div class="jr-form-foot"><span class="jr-count">0 / 500</span><button type="submit" class="jr-submit">发布评论</button></div>' +
      '  <div class="jr-msg" role="status"></div>' +
      '</form>' +
      '<div class="jr-list-wrap"><h4>评论 <span class="jr-list-cnt"></span></h4><div class="jr-list"><div class="jr-loading">加载中…</div></div></div>';

    var nameInput = container.querySelector('.jr-name');
    var savedName = lsGet(LS_NAME);
    if (typeof savedName === 'string') nameInput.value = savedName;
    var textArea = container.querySelector('.jr-text');
    var counter = container.querySelector('.jr-count');
    textArea.addEventListener('input', function () { counter.textContent = textArea.value.length + ' / 500'; });

    // 我的评分：以服务端为准
    fetchMyVote(id).then(function (vote) {
      if (dialogId !== id) return;
      var cur = vote ? vote.stars : 0;
      paintMine(container, cur);
    }).catch(function () { /* 离线时沿用本地缓存 */ });

    container.querySelectorAll('.jr-mine .jr-star').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var n = Number(btn.getAttribute('data-star'));
        var msg = container.querySelector('.jr-msg');
        container.querySelectorAll('.jr-mine .jr-star').forEach(function (b) { b.disabled = true; });
        rate(id, n).then(function () {
          if (dialogId !== id) return;
          paintMine(container, n);
          paintSummary(container, id);
          msg.textContent = '已评分：' + n + ' 星';
          msg.className = 'jr-msg ok';
        }).catch(function (err) {
          msg.textContent = '评分失败：' + err.message;
          msg.className = 'jr-msg err';
        }).finally(function () {
          container.querySelectorAll('.jr-mine .jr-star').forEach(function (b) { b.disabled = false; });
        });
      });
    });

    container.querySelector('.jr-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var msg = container.querySelector('.jr-msg');
      var btn = container.querySelector('.jr-submit');
      var body = textArea.value.trim();
      if (!body) { msg.textContent = '请先写点内容'; msg.className = 'jr-msg err'; return; }
      btn.disabled = true;
      postComment(id, nameInput.value, body).then(function (doc) {
        if (dialogId !== id) return;
        textArea.value = ''; counter.textContent = '0 / 500';
        msg.textContent = '评论已发布'; msg.className = 'jr-msg ok';
        prependComment(container, doc);
        paintSummary(container, id);
      }).catch(function (err) {
        msg.textContent = '发布失败：' + err.message; msg.className = 'jr-msg err';
      }).finally(function () { btn.disabled = false; });
    });

    listComments(id).then(function (docs) {
      if (dialogId !== id) return;
      var list = container.querySelector('.jr-list');
      var cnt = container.querySelector('.jr-list-cnt');
      cnt.textContent = '（' + (stats[id] ? stats[id].comments : docs.length) + '）';
      if (!docs.length) { list.innerHTML = '<div class="jr-empty">还没有评论，来说两句吧。</div>'; return; }
      list.innerHTML = docs.map(commentHtml).join('');
    }).catch(function () {
      if (dialogId !== id) return;
      container.querySelector('.jr-list').innerHTML = '<div class="jr-empty">评论加载失败，请稍后重试。</div>';
    });
  }

  function paintMine(container, n) {
    container.querySelectorAll('.jr-mine .jr-star').forEach(function (b) {
      b.classList.toggle('on', Number(b.getAttribute('data-star')) <= n);
    });
  }
  function paintSummary(container, id) {
    var st = stats[id] || { avg: 0, count: 0, comments: 0 };
    var box = container.querySelector('.jr-summary');
    if (!box) return;
    box.innerHTML = st.count > 0
      ? starRow(st.avg, false) + '<span class="jr-avg"><b>' + st.avg.toFixed(1) + '</b> 分 · ' + st.count + ' 人评分 · ' + st.comments + ' 条评论</span>'
      : '<span class="jr-avg">暂无评分，来打第一个分吧</span>';
    var cnt = container.querySelector('.jr-list-cnt');
    if (cnt) cnt.textContent = '（' + st.comments + '）';
  }
  function commentHtml(d) {
    return '<div class="jr-comment"><div class="jr-c-head"><b>' + esc(d.name || '匿名访客') + '</b><time>' +
      esc(fmtTime(d.$createdAt)) + '</time></div><div class="jr-c-body">' + esc(d.body) + '</div></div>';
  }
  function prependComment(container, d) {
    var list = container.querySelector('.jr-list');
    var empty = list.querySelector('.jr-empty');
    if (empty) list.innerHTML = '';
    list.insertAdjacentHTML('afterbegin', commentHtml(d));
  }

  /* ---------- 书架排序 ---------- */
  function initShelfSort() {
    var shelf = document.querySelector('.shelf');
    var bar = document.getElementById('shelfSort');
    if (!shelf || !bar) return;
    var books = Array.prototype.slice.call(shelf.querySelectorAll('.book'));
    books.forEach(function (b, i) { b.setAttribute('data-orig', i); });
    var mode = 'default';
    function apply() {
      var arr = books.slice();
      if (mode !== 'default') {
        arr.sort(function (a, b) {
          var sa = stats[a.querySelector('[data-rate]').getAttribute('data-rate')] || { avg: 0, count: 0, comments: 0 };
          var sb = stats[b.querySelector('[data-rate]').getAttribute('data-rate')] || { avg: 0, count: 0, comments: 0 };
          if (mode === 'rating') {
            if ((sa.count > 0) !== (sb.count > 0)) return sa.count > 0 ? -1 : 1; // 无评分排后
            return sb.avg - sa.avg || sb.count - sa.count;
          }
          return sb.comments - sa.comments || sb.avg - sa.avg;
        });
      } else {
        arr.sort(function (a, b) { return Number(a.getAttribute('data-orig')) - Number(b.getAttribute('data-orig')); });
      }
      arr.forEach(function (b) { shelf.appendChild(b); });
    }
    bar.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        mode = btn.getAttribute('data-sort');
        bar.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b === btn); });
        apply();
      });
    });
    window.addEventListener('jzs-stats', apply);
  }

  /* ---------- 样式 ---------- */
  function injectStyles() {
    var css = '' +
      '.rcard-rate{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px dashed var(--site-border,#e2dac5);font-size:12.5px;color:var(--site-muted,#7c7666);cursor:pointer;line-height:1.5}' +
      '.rcard-rate b{color:var(--site-accent,#2b4c7e);font-size:13.5px}' +
      '.rcard-rate .jr-stars{color:#b98a2f;font-size:14px}' +
      '.rcard-rate .jr-stars.jr-empty{color:#c9c2ae}' +
      '.rcard-rate .jr-meta{opacity:.85}' +
      '.rcard-rate:hover{color:var(--site-accent,#2b4c7e)}' +
      '.rcard-rate:focus-visible{outline:2px solid var(--site-accent,#2b4c7e);outline-offset:2px;border-radius:6px}' +
      '.wall .rcard-rate,.honor .rcard-rate{margin:0 16px 12px;padding-top:6px}' +
      '.honor.text-card .rcard-rate{margin:10px 0 0}' +
      '.comp-card .rcard-rate{margin-top:10px}' +
      '.shelf-sort{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 16px;font-size:13.5px;color:var(--site-muted,#7c7666)}' +
      '.shelf-sort button{font:inherit;font-size:13px;padding:5px 14px;border-radius:999px;border:1px solid var(--site-border,#e2dac5);background:var(--site-surface,#fffdf6);color:var(--site-muted,#7c7666);cursor:pointer;transition:all .18s}' +
      '.shelf-sort button:hover{border-color:var(--site-accent,#2b4c7e);color:var(--site-accent,#2b4c7e)}' +
      '.shelf-sort button.on{background:var(--site-accent,#2b4c7e);border-color:var(--site-accent,#2b4c7e);color:#fff}' +
      '.jr-overlay{position:fixed;inset:0;z-index:200;background:rgba(24,25,30,.55);display:none;align-items:flex-start;justify-content:center;padding:5vh 16px;overflow-y:auto;backdrop-filter:blur(3px)}' +
      '.jr-overlay.open{display:flex}' +
      '.jr-panel{background:var(--site-surface,#fffdf6);border:1px solid var(--site-border,#e2dac5);border-radius:14px;max-width:560px;width:100%;box-shadow:0 24px 60px rgba(0,0,0,.25);animation:jr-in .22s ease}' +
      '@keyframes jr-in{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}' +
      '.jr-head{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--site-border,#e2dac5)}' +
      '.jr-title{font-size:17px;color:var(--site-fg,#2b2c30);flex:1;line-height:1.4}' +
      '.jr-close{border:none;background:transparent;font-size:16px;cursor:pointer;color:var(--site-muted,#7c7666);width:32px;height:32px;border-radius:8px;flex:none}' +
      '.jr-close:hover{background:rgba(0,0,0,.06)}' +
      '.jr-body{padding:16px 20px 20px}' +
      '.jr-summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}' +
      '.jr-avg{font-size:13.5px;color:var(--site-muted,#7c7666)}' +
      '.jr-avg b{font-size:18px;color:var(--site-accent,#2b4c7e)}' +
      '.jr-starrow{display:inline-flex;gap:2px}' +
      '.jr-star{color:#d9d2bd;font-size:18px;line-height:1;background:none;border:none;padding:0}' +
      '.jr-star.on{color:#b98a2f}' +
      '.jr-interactive .jr-star{font-size:26px;cursor:pointer;transition:transform .12s}' +
      '.jr-interactive .jr-star:hover{transform:scale(1.18)}' +
      '.jr-interactive .jr-star:disabled{opacity:.5;cursor:wait}' +
      '.jr-mine{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border:1px dashed var(--site-border,#e2dac5);border-radius:10px;margin-bottom:14px}' +
      '.jr-mine-label{font-size:13.5px;font-weight:700;color:var(--site-fg,#2b2c30)}' +
      '.jr-mine-tip{font-size:12px;color:var(--site-muted,#7c7666)}' +
      '.jr-form{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}' +
      '.jr-name,.jr-text{font:inherit;font-size:14px;padding:8px 12px;border:1px solid var(--site-border,#e2dac5);border-radius:8px;background:#fff;color:var(--site-fg,#2b2c30);width:100%}' +
      '.jr-name:focus,.jr-text:focus{outline:none;border-color:var(--site-accent,#2b4c7e)}' +
      '.jr-text{resize:vertical;min-height:70px}' +
      '.jr-form-foot{display:flex;align-items:center;justify-content:space-between;gap:10px}' +
      '.jr-count{font-size:12px;color:var(--site-muted,#7c7666)}' +
      '.jr-submit{font:inherit;font-size:14px;font-weight:700;padding:7px 20px;border-radius:999px;border:none;background:var(--site-accent,#2b4c7e);color:#fff;cursor:pointer}' +
      '.jr-submit:hover{filter:brightness(1.12)}' +
      '.jr-submit:disabled{opacity:.55;cursor:wait}' +
      '.jr-msg{font-size:12.5px;min-height:1em}' +
      '.jr-msg.ok{color:#2e7d32}' +
      '.jr-msg.err{color:#b54534}' +
      '.jr-list-wrap h4{font-size:14.5px;color:var(--site-fg,#2b2c30);margin-bottom:8px}' +
      '.jr-list-cnt{font-weight:400;color:var(--site-muted,#7c7666);font-size:12.5px}' +
      '.jr-list{display:flex;flex-direction:column;gap:10px;max-height:300px;overflow-y:auto}' +
      '.jr-comment{border:1px solid var(--site-border,#e2dac5);border-radius:10px;padding:10px 12px;background:#fff}' +
      '.jr-c-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:13px}' +
      '.jr-c-head b{color:var(--site-accent,#2b4c7e)}' +
      '.jr-c-head time{color:var(--site-muted,#7c7666);font-size:12px;flex:none}' +
      '.jr-c-body{font-size:13.5px;margin-top:4px;white-space:pre-wrap;word-break:break-word}' +
      '.jr-empty,.jr-loading{font-size:13px;color:var(--site-muted,#7c7666);padding:8px 0}' +
      '@media (max-width:600px){.jr-overlay{padding:0;align-items:stretch}.jr-panel{max-width:none;border-radius:0;min-height:100vh}.jr-list{max-height:none}}';
    var tag = document.createElement('style');
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  /* ---------- 初始化 ---------- */
  function init() {
    var placeholders = document.querySelectorAll('[data-rate]');
    if (!placeholders.length) return; // 未配置：渐进增强，什么都不显示
    injectStyles();
    decorateCards(document);
    initShelfSort();
    refreshStats(false);
  }

  window.JZSCommunity = { getStats: getStats, decorateCards: decorateCards, renderDialog: renderDialog };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();