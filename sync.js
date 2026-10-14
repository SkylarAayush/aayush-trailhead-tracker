const puppeteer = require('puppeteer');

const WEB_APP_URL = process.env.WEB_APP_URL;

if (!WEB_APP_URL) {
  console.error('ERROR: WEB_APP_URL environment variable is missing.');
  process.exit(1);
}

async function fetchUsersToScrape() {
  console.log('Fetching registered users from Google Sheet...');
  const res = await fetch(WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'getUsers' }),
    redirect: 'follow'
  });
  const data = await res.json();
  return data.users || [];
}

async function scrapeProfile(browser, profileUrl) {
  const page = await browser.newPage();
  
  // Anti-bot detection stealth settings
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  await page.setViewport({ width: 1440, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  let interceptedStats = null;

  // Intercept the underlying GraphQL response from Trailhead's API
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('trailhead') && (url.includes('graphql') || url.includes('profile'))) {
      try {
        const json = await response.json();
        const stats = json?.data?.profile?.trailheadStats || json?.data?.profile?.userProfileCounts;
        if (stats) {
          interceptedStats = {
            badges: Number(stats.earnedBadgesCount || stats.badgesCount) || 0,
            points: Number(stats.earnedPointsSum || stats.pointsCount) || 0,
            trails: Number(stats.completedTrailCount || stats.trailsCount) || 0,
            rank: stats.rank?.title || ''
          };
          console.log(`[API Intercepted]: ${JSON.stringify(interceptedStats)}`);
        }
      } catch (_) {}
    }
  });

  try {
    console.log(`Visiting profile: ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 6000));

    // If API intercepted directly, return it
    if (interceptedStats && (interceptedStats.badges > 0 || interceptedStats.points > 0)) {
      return interceptedStats;
    }

    // Otherwise, parse the rendered DOM
    const domStats = await page.evaluate(() => {
      let badges = 0;
      let points = 0;
      let trails = 0;
      let rank = '';

      const text = document.body.innerText || '';

      // Match numbers next to Badges/Points in text
      const bM = text.match(/(\d[\d,]*)\s*(?:\n|\s+)?Badges/i);
      const pM = text.match(/(\d[\d,]*)\s*(?:\n|\s+)?Points/i);
      const tM = text.match(/(\d[\d,]*)\s*(?:\n|\s+)?Trails/i);
      const rM = text.match(/(Ranger|Expeditioner|Explorer|Adventurer|Mountaineer|Hiker|Scout)/i);

      if (bM) badges = parseInt(bM[1].replace(/,/g, ''), 10);
      if (pM) points = parseInt(pM[1].replace(/,/g, ''), 10);
      if (tM) trails = parseInt(tM[1].replace(/,/g, ''), 10);
      if (rM) rank = rM[1];

      // If still 0, look for all elements with numbers
      if (!badges || !points) {
        document.querySelectorAll('div, span, p, h1, h2, h3').forEach(el => {
          const t = el.innerText ? el.innerText.trim() : '';
          if (/^(\d[\d,]*)$/.test(t)) {
            const next = el.nextElementSibling ? el.nextElementSibling.innerText.trim().toLowerCase() : '';
            const parent = el.parentElement ? el.parentElement.innerText.toLowerCase() : '';
            if (next === 'badges' || parent.includes('badges')) badges = parseInt(t.replace(/,/g, ''), 10);
            if (next === 'points' || parent.includes('points')) points = parseInt(t.replace(/,/g, ''), 10);
            if (next === 'trails' || parent.includes('trails')) trails = parseInt(t.replace(/,/g, ''), 10);
          }
        });
      }

      return { badges, points, trails, rank };
    });

    console.log(`-> Extracted: ${domStats.badges} Badges | ${domStats.points.toLocaleString()} Points | ${domStats.trails} Trails | Rank: ${domStats.rank}`);
    return domStats;
  } catch (err) {
    console.error(`Error scraping ${profileUrl}:`, err.message);
    return null;
  } finally {
    await page.close();
  }
}

async function run() {
  console.log('=== Starting Aayush Trailhead Tracker Sync ===');
  
  const users = await fetchUsersToScrape();
  if (!users || users.length === 0) {
    console.log('No users found in Google Sheet. Exiting.');
    return;
  }
  console.log(`Found ${users.length} member(s) to scrape.`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const scrapedMembers = [];

  for (const user of users) {
    if (!user.profileUrl) {
      console.log(`Skipping ${user.name}: No Profile URL set.`);
      continue;
    }

    console.log(`\nProcessing: ${user.name} (${user.email})...`);
    const stats = await scrapeProfile(browser, user.profileUrl);

    if (stats && (stats.badges > 0 || stats.points > 0)) {
      scrapedMembers.push({
        email: user.email,
        name: user.name,
        badges: stats.badges,
        points: stats.points,
        trails: stats.trails,
        rank: stats.rank
      });
    }
  }

  await browser.close();

  if (scrapedMembers.length > 0) {
    console.log(`\nPosting ${scrapedMembers.length} record(s) to Google Apps Script...`);
    const updateRes = await fetch(WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'batchUpdate',
        members: scrapedMembers
      }),
      redirect: 'follow'
    });
    const updateJson = await updateRes.json();
    console.log('Server response:', JSON.stringify(updateJson));
  } else {
    console.log('No stats were extracted.');
  }

  console.log('\n=== Sync Process Complete ===');
}

run().catch(console.error);
