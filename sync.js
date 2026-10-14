  // Intercept the underlying GraphQL response from Trailhead's API
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('trailhead') && (url.includes('graphql') || url.includes('profile'))) {
      try {
        const json = await response.json();
        const stats = json?.data?.profile?.trailheadStats || json?.data?.profile?.userProfileCounts;
        if (stats) {
          const newBadges = Number(stats.earnedBadgesCount || stats.badgesCount) || 0;
          const newPoints = Number(stats.earnedPointsSum || stats.pointsCount) || 0;
          const newTrails = Number(stats.completedTrailCount || stats.trailsCount) || 0;
          const newRank   = stats.rank?.title || '';

          // Only keep or update if it has valid badges or points (never overwrite with 0!)
          if (!interceptedStats) {
            interceptedStats = { badges: newBadges, points: newPoints, trails: newTrails, rank: newRank };
          } else {
            if (newBadges > interceptedStats.badges) interceptedStats.badges = newBadges;
            if (newPoints > interceptedStats.points) interceptedStats.points = newPoints;
            if (newTrails > interceptedStats.trails) interceptedStats.trails = newTrails;
            if (newRank) interceptedStats.rank = newRank;
          }
          console.log(`[API Intercepted]: ${JSON.stringify(interceptedStats)}`);
        }
      } catch (_) {}
    }
  });
