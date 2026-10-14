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
  
  await page.setViewport({ width: 1440, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  try {
    console.log(`Visiting profile: ${profileUrl}`);
    
    // Navigate and allow network to finish
    await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Give the dynamic Salesforce LWC components 8 seconds to render badges on screen
    await new Promise(r => setTimeout(r, 8000));

    const stats = await page.evaluate(() => {
      let badges = 0;
      let points = 0;
      let trails = 0;
      let rank = '';

      const bodyText = document.body.innerText || '';

      // Pattern 1: Look for "8\nBadges" or "8 Badges"
      const badgeMatch = bodyText.match(/([\d,]+)\s*(?:\n|\s+)\s*Badges/i);
      if (badgeMatch) badges = parseInt(badgeMatch[1].replace(/,/g, ''), 10);

      // Pattern 2: Look for "11,775\nPoints" or "11,775 Points"
      const pointMatch = bodyText.match(/([\d,]+)\s*(?:\n|\s+)\s*Points/i);
      if (pointMatch) points = parseInt(pointMatch[1].replace(/,/g, ''), 10);

      // Pattern 3: Look for "1\nTrails" or "1 Trails"
      const trailMatch = bodyText.match(/([\d,]+)\s*(?:\n|\s+)\s*Trails/i);
      if (trailMatch) trails = parseInt(trailMatch[1].replace(/,/g, ''), 10);

      // Pattern 4: Rank
      const rankMatch = bodyText.match(/(Ranger|Expeditioner|Explorer|Adventurer|Mountaineer|Hiker|Scout)/i);
      if (rankMatch) rank = rankMatch[1];

      // Fallback: Check for data attributes or span values
      if (!badges || !points) {
        const elements = document.querySelectorAll('h1, h2, h3, h4, span, div, p');
        for (let i = 0; i < elements.length; i++) {
          const t = (elements[i].innerText || '').trim();
          if (t.toLowerCase() === 'badges' && i > 0) {
            const prev = (elements[i-1].innerText || '').replace(/,/g, '').trim();
            if (/^\d+$/.test(prev)) badges = parseInt(prev, 10);
          }
          if (t.toLowerCase() === 'points' && i > 0) {
            const prev = (elements[i-1].innerText || '').replace(/,/g, '').trim();
            if (/^\d+$/.test(prev)) points = parseInt(prev, 10);
          }
        }
      }

      return { badges, points, trails, rank };
    });

    console.log(`-> Extracted: ${stats.badges} Badges | ${stats.points.toLocaleString()} Points | ${stats.trails} Trails | Rank: ${stats.rank}`);
    return stats;
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
      '--disable-accelerated-2d-canvas',
      '--disable-gpu'
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
