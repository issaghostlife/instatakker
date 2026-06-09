// ==UserScript==
// @name         Instatakker
// @namespace    http://instatakker.io
// @version      1.0.0
// @description  Instagram Unfollow + Auto Like (post + comments) — press Enter
// @author       Instatakker
// @match        https://www.instagram.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=instagram.com
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  const VERSION = '1.0.0';

  // ======================== CONFIG ========================

  const DEFAULTS = {
    unfollow: {
      maxUnfollows: 100,
      minDelay: 8000,
      maxDelay: 14000,
      scrollWait: 5000,
      hourlyLimit: 60,
      emptyRoundsBeforeStop: 8,
    },
    like: {
      maxLikes: 300,            // total likes (post + comments combined)
      minDelay: 3000,
      maxDelay: 6000,
      hourlyLimit: 150,
      emptyRoundsBeforeStop: 5,
      maxCommentsPerPost: 150,  // max comments to like on a single post
      minCommentDelay: 800,
      maxCommentDelay: 1500,
    },
  };

  let config = {
    unfollow: { ...DEFAULTS.unfollow },
    like: { ...DEFAULTS.like },
  };

  let running = false;
  let stopped = false;
  let mode = 'unfollow';

  let state = {
    unfollowed: 0,
    liked: 0,
    commentsLiked: 0,
    postsEngaged: 0,
    startTime: null,
    hourlyCount: 0,
    hourlyReset: Date.now(),
    emptyRounds: 0,
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const randDelay = (min, max) =>
    Math.floor(Math.random() * (max - min + 1)) + min;

  function log(msg) {
    console.log(`[Instatakker] ${msg}`);
  }

  // ======================== LIMIT TRACKING (learns over time) ========================

  /**
   * Instagram has dynamic limits that change based on account age, activity, etc.
   * We track when a rate limit happens and learn from it.
   */
  const LIMITS_KEY = 'instatakker_limits';

  function loadLimits() {
    try {
      const raw = localStorage.getItem(LIMITS_KEY);
      if (raw) return JSON.parse(raw);
    } catch(e) {}
    return {
      // Running averages for when limits were hit
      lastHourlyLimit: 150,
      lastActionBeforeBlock: 0,
      blockStartTime: null,
      blockHistory: [], // [{hourlyCount, action, timestamp}]
      learnedHourlyCap: 150,
      learnedPerPostCap: 150,
    };
  }

  function saveLimits(limits) {
    try {
      localStorage.setItem(LIMITS_KEY, JSON.stringify(limits));
    } catch(e) {}
  }

  const limits = loadLimits();

  /**
   * Record when we hit a rate limit / action block.
   * Over time this builds a profile of what Instagram allows for this account.
   */
  function recordBlock(action) {
    limits.blockHistory.push({
      action: action,
      hourlyCount: state.hourlyCount,
      timestamp: Date.now(),
    });

    // Keep last 10 blocks
    if (limits.blockHistory.length > 10) {
      limits.blockHistory = limits.blockHistory.slice(-10);
    }

    // Update learned limits (moving average)
    const recentBlocks = limits.blockHistory.slice(-5);
    if (recentBlocks.length >= 2) {
      const avgHourly = Math.round(recentBlocks.reduce((s, b) => s + b.hourlyCount, 0) / recentBlocks.length);
      limits.learnedHourlyCap = Math.max(30, Math.round(avgHourly * 0.85)); // 85% of average block point
      limits.learnedPerPostCap = Math.max(20, Math.round(limits.learnedHourlyCap / 3));
    }

    limits.lastHourlyLimit = state.hourlyCount;
    limits.lastActionBeforeBlock = state.liked;
    limits.blockStartTime = Date.now();

    saveLimits(limits);
    log(`📊 Learned: hourly cap ≈ ${limits.learnedHourlyCap}, per-post cap ≈ ${limits.learnedPerPostCap}`);
  }

  function getSafeLimits() {
    if (limits.blockHistory.length >= 2) {
      return {
        hourlyCap: Math.min(config.like.hourlyLimit, limits.learnedHourlyCap),
        perPostCap: Math.min(config.like.maxCommentsPerPost, limits.learnedPerPostCap),
      };
    }
    return {
      hourlyCap: config.like.hourlyLimit,
      perPostCap: config.like.maxCommentsPerPost,
    };
  }

  // ======================== UNFOLLOW MODE ========================

  function getFollowingButtons() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return [];
    return [...dialog.querySelectorAll('button')].filter(b => {
      if (!b.offsetParent) return false;
      return (b.innerText || '').trim() === 'Following';
    });
  }

  function clickUnfollowConfirm() {
    const btn = [...document.querySelectorAll('button')].find(b => {
      if (!b.offsetParent) return false;
      return (b.innerText || '').trim() === 'Unfollow';
    });
    if (btn) { btn.click(); return true; }
    return false;
  }

  function scrollFollowingList() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return false;
    const scrollables = [...dialog.querySelectorAll('div')].filter(d => {
      try { return d.scrollHeight > d.clientHeight + 30; } catch(e) { return false; }
    });
    if (scrollables.length > 0) {
      scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight)[0].scrollTop += 800;
      return true;
    }
    return false;
  }

  // ======================== LIKE MODE (Post + Comments) ========================

  function likeCurrentPost() {
    const likeSvg = document.querySelector('svg[aria-label="Like"]');
    if (!likeSvg) return false;
    const clickable = likeSvg.closest('button') || likeSvg.closest('span[role="button"]') || likeSvg.closest('div[role="button"]') || likeSvg.parentElement;
    if (!clickable) return false;
    clickable.click();
    return true;
  }

  /**
   * Find "Load more comments" button and click it.
   * This is the SVG with aria-label="Load more comments" you showed.
   */
  function clickLoadMoreComments() {
    const loadMoreSvg = document.querySelector('svg[aria-label="Load more comments"]');
    if (!loadMoreSvg) return false;

    const clickable = loadMoreSvg.closest('button') ||
                      loadMoreSvg.closest('div[role="button"]') ||
                      loadMoreSvg.closest('span') ||
                      loadMoreSvg.parentElement;
    if (!clickable) return false;

    clickable.click();
    return true;
  }

  /**
   * Find all unliked comment like buttons on the current post.
   */
  function getUnlikeCommentButtons() {
    const allCommentLikeSvgs = [...document.querySelectorAll('ul ul svg[aria-label="Like"]')];
    const seen = new Set();
    return allCommentLikeSvgs.filter(svg => {
      const li = svg.closest('li');
      if (!li || seen.has(li)) return false;
      seen.add(li);
      return true;
    });
  }

  function likeComment(svg) {
    const clickable = svg.closest('button') || svg.closest('span[role="button"]') || svg.parentElement;
    if (!clickable) return false;
    clickable.click();
    return true;
  }

  function scrollCommentSection() {
    // Find the scrollable comments area
    const commentAreas = [...document.querySelectorAll('ul')].filter(ul => {
      try { return ul.scrollHeight > ul.clientHeight + 20; } catch(e) { return false; }
    });
    if (commentAreas.length > 0) {
      commentAreas[0].scrollTop = commentAreas[0].scrollHeight;
      return true;
    }

    // Fallback: scroll inside the dialog
    const dialog = document.querySelector('div[role="dialog"]');
    if (dialog) {
      const scrollables = [...dialog.querySelectorAll('div')].filter(d => {
        try { return d.scrollHeight > d.clientHeight + 30; } catch(e) { return false; }
      });
      if (scrollables.length > 0) {
        scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight)[0].scrollTop += 500;
        return true;
      }
    }
    return false;
  }

  function isInPostView() {
    return !!document.querySelector('div[role="dialog"] article');
  }

  /**
   * Check if we've been rate-limited by looking for action block indicators.
   * Instagram usually just stops responding to clicks or shows no visual change.
   */
  function checkRateLimited() {
    // If we've been trying and nothing is happening, we might be blocked
    // We detect by checking if we've exceeded learned limits
    const safe = getSafeLimits();
    if (state.hourlyCount >= safe.hourlyCap) {
      return true;
    }
    return false;
  }

  /**
   * Like comments on the current post — keeps clicking "Load more comments"
   * until no more load buttons appear, then scrolls and continues.
   */
  async function likeCommentsOnPost(logArea, statusEl) {
    let commentsLiked = 0;
    let loadMoreClicks = 0;
    let scrollRounds = 0;
    const maxRounds = 50; // safety limit for total rounds
    const safeLimits = getSafeLimits();
    const perPostCap = safeLimits.perPostCap;

    while (commentsLiked < perPostCap && loadMoreClicks + scrollRounds < maxRounds) {
      if (stopped || !running) break;

      // Check hourly limit
      if (state.hourlyCount >= safeLimits.hourlyCap) {
        if (statusEl) {
          statusEl.textContent = `⏳ Hit learned hourly limit (${safeLimits.hourlyCap})`;
          statusEl.style.background = '#ff6b9d22';
          statusEl.style.border = '1px solid #ff6b9d';
        }
        recordBlock('hourly_limit');
        break;
      }

      // Step 1: Try clicking "Load more comments" button
      const loaded = clickLoadMoreComments();
      if (loaded) {
        loadMoreClicks++;
        await sleep(randDelay(1000, 2000));
        if (logArea) logArea.textContent = `📄 Loaded more comments (${loadMoreClicks}x)`;
      }

      // Step 2: Find and like unliked comments
      const commentSvgs = getUnlikeCommentButtons();
      const remaining = perPostCap - commentsLiked;
      const batch = commentSvgs.slice(0, remaining);

      if (batch.length > 0) {
        for (const svg of batch) {
          if (stopped || !running) break;
          if (!document.contains(svg)) continue;

          // Check hourly before each like
          if (state.hourlyCount >= safeLimits.hourlyCap) {
            if (statusEl) {
              statusEl.textContent = `⏳ Hit hourly limit at ${state.hourlyCount}`;
              statusEl.style.background = '#ff6b9d22';
            }
            recordBlock('hourly_limit');
            break;
          }

          const success = likeComment(svg);
          if (success) {
            commentsLiked++;
            state.liked++;
            state.hourlyCount++;
            state.commentsLiked++;

            if (logArea) {
              logArea.textContent = `💬 Liking comments: ${commentsLiked}/${perPostCap} (total: ${state.liked})`;
            }
            if (statusEl) {
              statusEl.textContent = `❤️${state.liked} | 💬${commentsLiked}`;
            }

            await sleep(randDelay(config.like.minCommentDelay, config.like.maxCommentDelay));
          } else {
            await sleep(500);
          }
        }
      } else {
        // Step 3: No unliked comments visible — try scrolling
        const scrolled = scrollCommentSection();
        if (scrolled) {
          scrollRounds++;
          await sleep(1500);
        } else {
          // Couldn't scroll and no load more button — we've reached the end
          break;
        }
      }
    }

    if (commentsLiked > 0) {
      log(`✅ Liked ${commentsLiked} comments on this post`);
      state.postsEngaged++;
    }

    return commentsLiked;
  }

  // ======================== MAIN ENGINE ========================

  async function instatakkerEngine() {
    state.startTime = state.startTime || Date.now();
    const logArea = document.getElementById('itk-log');
    const statusEl = document.getElementById('itk-status');
    const safeLimits = getSafeLimits();

    if (limits.blockHistory.length > 0) {
      if (logArea) {
        logArea.textContent = `🧠 Learned: hourly~${safeLimits.hourlyCap}, comments/post~${safeLimits.perPostCap}`;
      }
    }

    while (running && !stopped) {
      // Hourly limit
      if (Date.now() - state.hourlyReset > 3600000) {
        state.hourlyCount = 0;
        state.hourlyReset = Date.now();
      }

      if (state.hourlyCount >= safeLimits.hourlyCap) {
        const waitMs = 3600000 - (Date.now() - state.hourlyReset);
        const waitMin = Math.ceil(waitMs / 60000);
        if (logArea) logArea.textContent = `⏳ Hit hourly cap (${safeLimits.hourlyCap}) — waiting ${waitMin} min`;
        if (statusEl) {
          statusEl.textContent = `⏳`;
          statusEl.style.background = '#ff6b9d22';
          statusEl.style.border = '1px solid #ff6b9d';
        }
        await sleep(Math.min(waitMs + 5000, 3600000));
        state.hourlyCount = 0;
        state.hourlyReset = Date.now();

        // Reset warning style
        if (statusEl) {
          statusEl.style.background = '';
          statusEl.style.border = '';
        }
        continue;
      }

      const currentCount = mode === 'unfollow' ? state.unfollowed : state.liked;
      const maxLimit = mode === 'unfollow' ? config.unfollow.maxUnfollows : config.like.maxLikes;

      if (currentCount >= maxLimit) {
        if (logArea) logArea.textContent = `✅ Done! ${mode === 'unfollow' ? 'Unfollowed' : 'Liked'} ${currentCount}`;
        break;
      }

      if (mode === 'unfollow') {
        // ===================== UNFOLLOW =====================
        if (!document.querySelector('div[role="dialog"]')) {
          if (logArea) logArea.textContent = '⚠️ Open Following list (click "Following" on profile)';
          await sleep(2000);
          continue;
        }

        const buttons = getFollowingButtons();
        log(`Found ${buttons.length} "Following" buttons`);

        if (buttons.length === 0) {
          state.emptyRounds++;
          if (state.emptyRounds >= config.unfollow.emptyRoundsBeforeStop) {
            if (logArea) logArea.textContent = `🏁 No more "Following" accounts (${state.unfollowed} unfollowed)`;
            break;
          }
          if (logArea) logArea.textContent = `⚠️ No "Following" buttons (${state.emptyRounds}/${config.unfollow.emptyRoundsBeforeStop})`;
        } else {
          state.emptyRounds = 0;
          const btn = buttons[0];
          if (!document.contains(btn)) continue;
          if ((btn.innerText || '').trim() !== 'Following') continue;

          log(`Clicking "Following" #${state.unfollowed + 1}`);
          if (logArea) logArea.textContent = `▶ Unfollowing #${state.unfollowed + 1}...`;

          try { btn.scrollIntoView({ block: 'center' }); } catch(e) {}
          await sleep(400);
          btn.click();
          await sleep(1000);

          const confirmed = clickUnfollowConfirm();
          if (confirmed) {
            state.unfollowed++;
            state.hourlyCount++;
            updateUI();
            if (statusEl) statusEl.textContent = `✅${state.unfollowed}`;
            await sleep(randDelay(config.unfollow.minDelay, config.unfollow.maxDelay));
          } else {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            await sleep(1500);
            const stillThere = getFollowingButtons().some(b => document.contains(b) && b.innerText.trim() === 'Following' && b === btn);
            if (!stillThere) {
              state.unfollowed++;
              state.hourlyCount++;
              updateUI();
              if (statusEl) statusEl.textContent = `✅${state.unfollowed}`;
              await sleep(randDelay(config.unfollow.minDelay, config.unfollow.maxDelay));
            } else {
              if (logArea) logArea.textContent = '⚠️ Cooling 30s...';
              if (statusEl) {
                statusEl.textContent = `⚠️`;
                statusEl.style.background = '#ff6b9d22';
              }
              await sleep(30000);
              if (statusEl) statusEl.style.background = '';
            }
          }
        }
        scrollFollowingList();
        await sleep(config.unfollow.scrollWait);

      } else {
        // ===================== LIKE (Post + Comments) =====================

        // Check rate limit before engaging
        if (checkRateLimited()) {
          if (logArea) logArea.textContent = `🧠 Learned: hourly limit ~${safeLimits.hourlyCap}. Cooling...`;
          recordBlock('rate_limit_detected');
          await sleep(60000);
          continue;
        }

        // Open a post if not already in one
        if (!isInPostView()) {
          const firstPost = document.querySelector('article a[href*="/p/"]') ||
                            document.querySelector('article[role="presentation"] a');
          if (firstPost) {
            firstPost.click();
            await sleep(2500);
            if (logArea) logArea.textContent = `📱 Opened post (total liked: ${state.liked})`;
          } else {
            if (logArea) logArea.textContent = '⚠️ No posts found. Navigate to a hashtag or feed page.';
            await sleep(3000);
            continue;
          }
        }

        if (!isInPostView()) {
          if (logArea) logArea.textContent = '⚠️ Click on a post first, then press Enter';
          await sleep(2000);
          continue;
        }

        // --- Step 1: Like the post ---
        const likedPost = likeCurrentPost();
        if (likedPost) {
          state.liked++;
          state.hourlyCount++;
          state.postsEngaged++;
          if (logArea) logArea.textContent = `❤️ Liked post ${state.postsEngaged}`;
          if (statusEl) statusEl.textContent = `❤️${state.liked}`;
          log(`Liked post #${state.postsEngaged}`);
          await sleep(randDelay(1500, 3000));
        } else {
          if (logArea) logArea.textContent = `📌 Post already liked (${state.liked} total)`;
        }

        // --- Step 2: Like comments ---
        if (logArea) logArea.textContent = `💬 Liking comments on post ${state.postsEngaged}...`;
        const commentCount = await likeCommentsOnPost(logArea, statusEl);

        if (commentCount > 0) {
          log(`✅ Post ${state.postsEngaged}: liked ${commentCount} comments`);
          updateUI();
        }

        // --- Step 3: Close post and scroll to next ---
        if (!stopped && running) {
          if (logArea) logArea.textContent = `📱 Closing post — scrolling to next...`;
          log('Closing post modal');

          const closeSvg = document.querySelector('svg[aria-label="Close"]');
          if (closeSvg) {
            const closeBtn = closeSvg.closest('button') || closeSvg.parentElement;
            if (closeBtn) closeBtn.click();
          } else {
            // Escape to close
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          }
          await sleep(1500);

          // Scroll down
          window.scrollBy(0, 900);
          await sleep(2000);

          // Update limits display
          const newsafe = getSafeLimits();
          if (logArea) {
            logArea.textContent = `📊 Stats: ${state.liked} liked | hr:${state.hourlyCount}/${newsafe.hourlyCap} | comments/post:~${Math.round(state.commentsLiked / Math.max(1, state.postsEngaged))}`;
          }
        }
      }
    }

    running = false;
    if (logArea) {
      if (!logArea.textContent.includes('Done') && !logArea.textContent.includes('No more')) {
        const count = mode === 'unfollow' ? state.unfollowed : state.liked;
        const action = mode === 'unfollow' ? 'unfollowed' : 'liked';
        logArea.textContent = `■ Stopped (${count} ${action})`;
      }
    }
    if (statusEl) {
      statusEl.textContent = `■`;
      statusEl.style.background = '';
      statusEl.style.border = '';
    }

    // Save limits for next time
    saveLimits(limits);
    log(`Engine stopped. Limits saved for next session.`);
  }

  // ======================== UI ========================

  function updateUI() {
    const countEl = document.getElementById('itk-count');
    const progressEl = document.getElementById('itk-progress');
    const barEl = document.getElementById('itk-bar');
    const hourlyEl = document.getElementById('itk-hourly');
    const perPostEl = document.getElementById('itk-perpost');
    const engagedEl = document.getElementById('itk-engaged');

    const currentCount = mode === 'unfollow' ? state.unfollowed : state.liked;
    const maxCount = mode === 'unfollow' ? config.unfollow.maxUnfollows : config.like.maxLikes;

    if (countEl) countEl.textContent = currentCount;
    if (progressEl) progressEl.textContent = `${currentCount} / ${maxCount}`;
    if (barEl) barEl.style.width = `${(currentCount / maxCount) * 100}%`;
    if (hourlyEl) hourlyEl.textContent = `${state.hourlyCount} / ${mode === 'unfollow' ? config.unfollow.hourlyLimit : getSafeLimits().hourlyCap}`;

    if (mode === 'like') {
      if (perPostEl) {
        const avg = state.postsEngaged > 0 ? Math.round(state.commentsLiked / state.postsEngaged) : 0;
        perPostEl.textContent = `${avg} avg`;
      }
      if (engagedEl) engagedEl.textContent = state.postsEngaged;
    }
  }

  function createPanel() {
    const existing = document.getElementById('instatakker-panel');
    if (existing) existing.remove();

    try {
      const saved = sessionStorage.getItem('instatakker_state');
      if (saved) state = { ...state, ...JSON.parse(saved) };
    } catch(e) {}

    const avgComments = state.postsEngaged > 0 ? Math.round(state.commentsLiked / state.postsEngaged) : 0;
    const safe = getSafeLimits();
    const hasLearned = limits.blockHistory.length >= 2;

    const panel = document.createElement('div');
    panel.id = 'instatakker-panel';
    panel.innerHTML = `
      <div style="position:fixed;top:20px;right:20px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;width:370px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);background:#0f0f1a;color:#e0e0e0;padding:16px;user-select:none;border:1px solid rgba(255,0,80,0.25);">

        <!-- Header -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;cursor:move;" id="itk-drag">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:16px;">⏹</span>
            <h2 style="margin:0;font-size:17px;font-weight:700;color:#ff0050;letter-spacing:-0.3px;">Instatakker</h2>
          </div>
          <span style="font-size:10px;opacity:0.4;background:#1a1a2e;padding:2px 6px;border-radius:4px;">v${VERSION}</span>
        </div>

        <!-- Mode Tabs -->
        <div style="display:flex;gap:4px;margin-bottom:10px;background:#1a1a2e;border-radius:8px;padding:3px;">
          <button id="itk-mode-unfollow" style="flex:1;padding:6px 10px;border:none;border-radius:6px;font-weight:600;font-size:12px;cursor:pointer;background:#ff0050;color:white;transition:all 0.2s;">Unfollow</button>
          <button id="itk-mode-like" style="flex:1;padding:6px 10px;border:none;border-radius:6px;font-weight:600;font-size:12px;cursor:pointer;background:transparent;color:#888;transition:all 0.2s;">Like</button>
        </div>

        <!-- Learned Limit Banner -->
        ${hasLearned ? `
        <div style="font-size:10px;color:#ff6b9d;background:#ff6b9d15;padding:4px 8px;border-radius:4px;margin-bottom:8px;border:1px solid #ff6b9d30;display:flex;justify-content:space-between;">
          <span>🧠 Learned</span>
          <span>hr~${safe.hourlyCap} | com/post~${safe.perPostCap}</span>
        </div>
        ` : ''}

        <!-- Main stat row -->
        <div id="itk-status" style="font-size:12px;padding:6px 10px;background:#1a1a2e;border-radius:6px;margin-bottom:8px;text-align:center;border:1px solid transparent;transition:all 0.2s;">
          Press <kbd style="background:#333;padding:1px 5px;border-radius:3px;border:1px solid #555;font-size:11px;">Enter</kbd> to start
        </div>

        <!-- Stats Grid -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
          <div style="background:#1a1a2e;border-radius:6px;padding:6px 8px;">
            <div style="font-size:10px;opacity:0.5;">Count</div>
            <div style="font-weight:700;font-size:16px;" id="itk-count">${mode === 'unfollow' ? state.unfollowed : state.liked}</div>
          </div>
          <div style="background:#1a1a2e;border-radius:6px;padding:6px 8px;">
            <div style="font-size:10px;opacity:0.5;">Progress</div>
            <div style="font-weight:600;font-size:13px;" id="itk-progress">${mode === 'unfollow' ? state.unfollowed : state.liked} / ${mode === 'unfollow' ? config.unfollow.maxUnfollows : config.like.maxLikes}</div>
          </div>
          <div style="background:#1a1a2e;border-radius:6px;padding:6px 8px;">
            <div style="font-size:10px;opacity:0.5;">Hourly</div>
            <div style="font-weight:600;font-size:13px;" id="itk-hourly">${state.hourlyCount} / ${mode === 'unfollow' ? config.unfollow.hourlyLimit : safe.hourlyCap}</div>
          </div>
          <div style="background:#1a1a2e;border-radius:6px;padding:6px 8px;display:${mode === 'like' ? 'block' : 'none'};">
            <div style="font-size:10px;opacity:0.5;">Comments/Post</div>
            <div style="font-weight:600;font-size:13px;" id="itk-perpost">${avgComments}</div>
          </div>
        </div>

        <!-- Progress bar -->
        <div style="width:100%;height:4px;background:#1a1a2e;border-radius:2px;margin:10px 0;overflow:hidden;">
          <div id="itk-bar" style="height:100%;background:linear-gradient(90deg,#ff0050,#ff6b9d);border-radius:2px;transition:width 0.3s;width:${((mode === 'unfollow' ? state.unfollowed : state.liked) / (mode === 'unfollow' ? config.unfollow.maxUnfollows : config.like.maxLikes)) * 100}%;"></div>
        </div>

        <!-- Posts Engaged (like mode) -->
        <div id="itk-engaged-row" style="display:${mode === 'like' ? 'flex' : 'none'};justify-content:space-between;font-size:11px;opacity:0.6;margin-bottom:8px;">
          <span>Posts: <span id="itk-engaged">${state.postsEngaged}</span></span>
          <span>Comments: ${state.commentsLiked}</span>
        </div>

        <!-- Log -->
        <div id="itk-log" style="font-size:11px;margin-top:6px;padding:6px 8px;border-radius:4px;background:#1a1a2e;min-height:18px;word-break:break-word;color:#aaa;line-height:1.4;">
          Ready
        </div>

        <!-- Instructions -->
        <div style="font-size:10px;opacity:0.4;margin-top:6px;text-align:center;">
          ${mode === 'unfollow' ? 'Following list → Enter' : 'Hashtag/feed → Enter'}
        </div>

        <!-- Settings -->
        <details style="margin-top:8px;">
          <summary style="cursor:pointer;font-size:11px;opacity:0.5;padding:4px 0;">⚙️ Settings</summary>
          <div id="itk-settings-unfollow" style="margin-top:6px;">
            <div style="font-size:10px;font-weight:600;color:#ff6b9d;margin-bottom:4px;">Unfollow Settings</div>
            <div style="margin:3px 0;">
              <label style="font-size:10px;opacity:0.7;display:block;">Max Unfollows</label>
              <input type="number" id="itk-cfg-max" value="${config.unfollow.maxUnfollows}" min="1" max="500" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;">
            </div>
            <div style="margin:3px 0;">
              <label style="font-size:10px;opacity:0.7;display:block;">Hourly Limit</label>
              <input type="number" id="itk-cfg-hourly" value="${config.unfollow.hourlyLimit}" min="1" max="200" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;">
            </div>
            <div style="margin:3px 0;">
              <label style="font-size:10px;opacity:0.7;display:block;">Min Delay (ms)</label>
              <input type="number" id="itk-cfg-mindelay" value="${config.unfollow.minDelay}" min="2000" max="60000" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;">
            </div>
            <div style="margin:3px 0;">
              <label style="font-size:10px;opacity:0.7;display:block;">Max Delay (ms)</label>
              <input type="number" id="itk-cfg-maxdelay" value="${config.unfollow.maxDelay}" min="3000" max="120000" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;">
            </div>
          </div>
          <div id="itk-settings-like" style="margin-top:6px;display:none;">
            <div style="font-size:10px;font-weight:600;color:#ff6b9d;margin-bottom:4px;">Like Settings</div>
            <div style="margin:3px 0;">
              <label style="font-size:10px;opacity:0.7;display:block;">Max Total Likes</label>
              <input type="number" id="itk-cfg-like-max" value="${config.like.maxLikes}" min="1" max="1000" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;">
            </div>
            <div style="margin:3px 0;">
              <label style="font-size:10px;opacity:0.7;display:block;">Hourly Limit</label>
              <input type="number" id="itk-cfg-like-hourly" value="${config.like.hourlyLimit}" min="1" max="500" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;">
            </div>
            <div style="margin:3px 0;">
              <label style="font-size:10px;opacity:0.7;display:block;">Max Comments/Post</label>
              <input type="number" id="itk-cfg-like-comments" value="${config.like.maxCommentsPerPost}" min="1" max="300" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;">
            </div>
            <div style="margin:3px 0;">
              <label style="font-size:10px;opacity:0.7;display:block;">Min Like Delay (ms)</label>
              <input type="number" id="itk-cfg-like-mindelay" value="${config.like.minDelay}" min="1000" max="30000" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;">
            </div>
            <div style="margin:3px 0;">
              <label style="font-size:10px;opacity:0.7;display:block;">Max Like Delay (ms)</label>
              <input type="number" id="itk-cfg-like-maxdelay" value="${config.like.maxDelay}" min="2000" max="60000" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;">
            </div>
          </div>
        </details>
      </div>
    `;

    document.body.appendChild(panel);

    // Draggable
    const dragHandle = panel.querySelector('#itk-drag');
    let isDragging = false, ox, oy;
    const p = panel.firstElementChild;
    dragHandle.addEventListener('mousedown', (e) => {
      isDragging = true;
      ox = e.clientX - p.getBoundingClientRect().left;
      oy = e.clientY - p.getBoundingClientRect().top;
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      p.style.left = (e.clientX - ox) + 'px';
      p.style.top = (e.clientY - oy) + 'px';
      p.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { isDragging = false; });

    // Tab switching
    const unfollowTab = panel.querySelector('#itk-mode-unfollow');
    const likeTab = panel.querySelector('#itk-mode-like');
    const settingsUnfollow = panel.querySelector('#itk-settings-unfollow');
    const settingsLike = panel.querySelector('#itk-settings-like');
    const engagedRow = panel.querySelector('#itk-engaged-row');
    const perPostCell = [...panel.querySelectorAll('div')].filter(d => d.textContent.includes('Comments/Post'))[0]?.parentElement;

    function switchMode(newMode) {
      if (running) return;
      mode = newMode;

      unfollowTab.style.background = newMode === 'unfollow' ? '#ff0050' : 'transparent';
      unfollowTab.style.color = newMode === 'unfollow' ? 'white' : '#888';
      likeTab.style.background = newMode === 'like' ? '#ff0050' : 'transparent';
      likeTab.style.color = newMode === 'like' ? 'white' : '#888';

      settingsUnfollow.style.display = newMode === 'unfollow' ? 'block' : 'none';
      settingsLike.style.display = newMode === 'like' ? 'block' : 'none';

      if (engagedRow) engagedRow.style.display = newMode === 'like' ? 'flex' : 'none';
      if (perPostCell) perPostCell.style.display = newMode === 'like' ? 'block' : 'none';

      updateUI();
    }

    unfollowTab.addEventListener('click', () => switchMode('unfollow'));
    likeTab.addEventListener('click', () => switchMode('like'));
  }

  // ======================== ENTER KEY ========================

  document.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.repeat) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();

      if (running) {
        stopped = true;
        running = false;
        const logArea = document.getElementById('itk-log');
        const statusEl = document.getElementById('itk-status');
        const count = mode === 'unfollow' ? state.unfollowed : state.liked;
        const action = mode === 'unfollow' ? 'unfollowed' : 'liked';
        if (logArea) logArea.textContent = `■ Stopped (${count} ${action})`;
        if (statusEl) { statusEl.textContent = `■ Stopped`; statusEl.style.background = ''; }
        log('Stopped by user');
        return;
      }

      // Read config
      if (mode === 'unfollow') {
        const maxEl = document.getElementById('itk-cfg-max');
        const hourlyEl = document.getElementById('itk-cfg-hourly');
        const minDelayEl = document.getElementById('itk-cfg-mindelay');
        const maxDelayEl = document.getElementById('itk-cfg-maxdelay');

        if (maxEl) config.unfollow.maxUnfollows = parseInt(maxEl.value) || DEFAULTS.unfollow.maxUnfollows;
        if (hourlyEl) config.unfollow.hourlyLimit = parseInt(hourlyEl.value) || DEFAULTS.unfollow.hourlyLimit;
        if (minDelayEl) config.unfollow.minDelay = parseInt(minDelayEl.value) || DEFAULTS.unfollow.minDelay;
        if (maxDelayEl) config.unfollow.maxDelay = parseInt(maxDelayEl.value) || DEFAULTS.unfollow.maxDelay;
      } else {
        const maxEl = document.getElementById('itk-cfg-like-max');
        const hourlyEl = document.getElementById('itk-cfg-like-hourly');
        const commentsEl = document.getElementById('itk-cfg-like-comments');
        const minDelayEl = document.getElementById('itk-cfg-like-mindelay');
        const maxDelayEl = document.getElementById('itk-cfg-like-maxdelay');

        if (maxEl) config.like.maxLikes = parseInt(maxEl.value) || DEFAULTS.like.maxLikes;
        if (hourlyEl) config.like.hourlyLimit = parseInt(hourlyEl.value) || DEFAULTS.like.hourlyLimit;
        if (commentsEl) config.like.maxCommentsPerPost = parseInt(commentsEl.value) || DEFAULTS.like.maxCommentsPerPost;
        if (minDelayEl) config.like.minDelay = parseInt(minDelayEl.value) || DEFAULTS.like.minDelay;
        if (maxDelayEl) config.like.maxDelay = parseInt(maxDelayEl.value) || DEFAULTS.like.maxDelay;
      }

      stopped = false;
      running = true;
      state.emptyRounds = 0;

      const logArea = document.getElementById('itk-log');
      const statusEl = document.getElementById('itk-status');
      if (logArea) logArea.textContent = `▶ Running... ${mode === 'unfollow' ? 'unfollowing' : 'liking'}...`;
      if (statusEl) {
        statusEl.textContent = `▶ Running`;
        statusEl.style.background = '';
        statusEl.style.border = '';
      }
      log(`Engine started in ${mode} mode`);

      await instatakkerEngine();
      running = false;
    }
  });

  // ======================== INIT ========================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createPanel);
  } else {
    createPanel();
  }

  console.log('%c⏹ Instatakker v' + VERSION + ' loaded — press Enter', 'color: #ff0050; font-size: 14px; font-weight: bold;');
})();