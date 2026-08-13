const express = require("express");

function createAdminAnalyticsRoutes({
  verifyJWT,
  verifyAdmin,
  verifyMainAdmin,
  asyncHandler,
  usersCollection,
  productsCollection,
  reportCollection,
  bookingCollection,
  paymentCollection,
  platformFeeCollection,
  categoriesCollection,
  STAFF_ROLES,
  statusMatch,
  round2,
  PLATFORM_FEES,
}) {
  const router = express.Router();

  const MONTH_SHORT = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  // Percentage change helper. When there's nothing to compare against
  // (previous period was 0), a plain ratio is meaningless - report 100%
  // growth if something was earned this period, or 0% if both are 0,
  // rather than Infinity/NaN.
  const pctChange = (current, previous) => {
    if (previous > 0) return round2(((current - previous) / previous) * 100);
    return current > 0 ? 100 : 0;
  };

  const dateKeyOf = (date, granularity) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    if (granularity === "year") return `${y}`;
    if (granularity === "month") return `${y}-${m}`;
    return `${y}-${m}-${d}`;
  };

  // Whole-day difference, always >= 0, based on calendar days so "3 days
  // ago" reads the way a person means it rather than counting exact hours.
  const daysBetween = (from, to) => {
    if (!from || !to) return 0;
    return Math.max(0, Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)));
  };

  // Every document with a real ObjectId carries a creation time for
  // free, even ones (like products and reports) that don't reliably
  // have their own createdAt field.
  const idTimestamp = (doc) => (doc?._id ? new Date(doc._id.getTimestamp()) : null);

  router.get(
    "/admin/analytics",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      // Signup chart granularity/filtering. `period` picks the x-axis
      // bucket size; `year`/`month` scope which slice of time we're
      // looking at.
      //   period=day   + year + month  -> every day in that month
      //   period=day   (no year/month) -> last 30 days ending today (default)
      //   period=month + year          -> every month in that year
      //   period=year                  -> every year that has any signups
      const period = ["day", "month", "year"].includes(req.query.period) ? req.query.period : "day";
      const filterYear = Number.isInteger(Number(req.query.year)) && req.query.year ? Number(req.query.year) : null;
      const filterMonth =
        Number.isInteger(Number(req.query.month)) && req.query.month ? Number(req.query.month) : null; // 1-12

      // Build the actual date range [rangeStart, rangeEnd] and the format
      // used to bucket + label each point, based on the selected period/scope.
      const now = new Date();
      let rangeStart;
      let rangeEnd;
      let dateFormat;
      if (period === "day" && filterYear && filterMonth) {
        rangeStart = new Date(filterYear, filterMonth - 1, 1);
        rangeEnd = new Date(filterYear, filterMonth, 0, 23, 59, 59, 999);
        dateFormat = "%Y-%m-%d";
      } else if (period === "month") {
        const y = filterYear || now.getFullYear();
        rangeStart = new Date(y, 0, 1);
        rangeEnd = new Date(y, 11, 31, 23, 59, 59, 999);
        dateFormat = "%Y-%m";
      } else if (period === "year") {
        rangeStart = null; // no lower bound - show every year on file
        rangeEnd = null;
        dateFormat = "%Y";
      } else {
        // default: last 30 days ending today, day by day
        rangeEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        rangeStart = new Date(rangeEnd);
        rangeStart.setDate(rangeStart.getDate() - 29);
        rangeStart.setHours(0, 0, 0, 0);
        dateFormat = "%Y-%m-%d";
      }

      const signupMatch = { createdAt: { $exists: true } };
      if (rangeStart && rangeEnd) signupMatch.createdAt = { $gte: rangeStart, $lte: rangeEnd };

      const [
        totalBuyers,
        totalSellers,
        totalAdmins,
        totalProducts,
        totalAvailable,
        totalBooked,
        totalAdvertised,
        totalSold,
        totalReported,
        bookings,
        payments,
        platformFees,
        allCategories,
        categoryAgg,
        signupAgg,
        signupYearsAgg,
      ] = await Promise.all([
        usersCollection.countDocuments({ role: "Buyer" }),
        usersCollection.countDocuments({ role: "Seller" }),
        usersCollection.countDocuments({ role: { $in: STAFF_ROLES } }),
        productsCollection.countDocuments({}),
        // "Available" means still purchasable - that includes Advertised
        // listings too (advertising just promotes an already-available
        // item, it doesn't take it off the market). Only Booked/Paid
        // items are no longer available.
        productsCollection.countDocuments({ status: statusMatch("Available", "Advertised") }),
        productsCollection.countDocuments({ status: statusMatch("Booked") }),
        productsCollection.countDocuments({ status: statusMatch("Advertised") }),
        productsCollection.countDocuments({ status: statusMatch("Paid") }),
        reportCollection.countDocuments({}),
        bookingCollection.find({ isDemo: { $ne: true } }).toArray(),
        paymentCollection.find({}).toArray(),
        platformFeeCollection.find({}).toArray(),
        // Every category that exists (even ones with zero products yet),
        // so the "Products by category" chart doesn't silently drop
        // empty ones.
        categoriesCollection.find({}).toArray(),
        productsCollection
          .aggregate([{ $group: { _id: "$category", count: { $sum: 1 } } }, { $sort: { count: -1 } }])
          .toArray(),
        usersCollection
          .aggregate([
            { $match: signupMatch },
            {
              $group: {
                _id: { $dateToString: { format: dateFormat, date: "$createdAt" } },
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ])
          .toArray(),
        usersCollection
          .aggregate([
            { $match: { createdAt: { $exists: true } } },
            { $group: { _id: { $year: "$createdAt" } } },
            { $sort: { _id: 1 } },
          ])
          .toArray(),
      ]);

      // totalAmountPaid is every taka actually collected so far - deposits
      // and full/remaining-balance payments alike (a payment record is
      // only ever created once money has actually cleared through bKash
      // or been confirmed in cash).
      const totalAmountPaid = payments.reduce((sum, p) => sum + (Number(p.price) || 0), 0);

      // The only money BuyTop actually earns: 150tk per completed sale +
      // 100tk per advertisement, as opposed to totalAmountPaid above
      // which is buyer money that passes through to sellers.
      const totalCompanyEarnings = round2(platformFees.reduce((sum, f) => sum + (Number(f.amount) || 0), 0));

      // Cancelled bookings are kept for reporting (see
      // /seller/cancel-requests/:id) but aren't a live order any more,
      // so they're pulled out before counting orders or outstanding
      // balance.
      const cancelledBookings = bookings.filter((b) => b.status === "Cancelled");
      const liveBookings = bookings.filter((b) => b.status !== "Cancelled");

      // Every order currently on file. "Completed" = the full price has
      // cleared (booking.status === "Paid"). Everything else ("Awaiting
      // Deposit" or "Booked" with just the 10% deposit down) is
      // incomplete and still has a balance outstanding.
      const totalOrders = liveBookings.length;
      const completedOrders = liveBookings.filter((b) => b.status === "Paid").length;
      const incompleteOrders = totalOrders - completedOrders;
      const cancelledOrders = cancelledBookings.length;

      // For every order that isn't fully paid yet, how much is still
      // owed: the full price if no deposit has cleared, or
      // price-minus-deposit if the deposit is already in.
      const totalPaymentRemaining = round2(
        liveBookings.reduce((sum, b) => {
          if (b.status === "Paid") return sum;
          const price = Number(b.price) || 0;
          const depositAmount = b.depositPaid ? Number(b.depositAmount || 0) : 0;
          return sum + Math.max(price - depositAmount, 0);
        }, 0)
      );

      // Merge every known category in with the counts we found, so a
      // category that has zero products yet still shows up (as a
      // zero-height bar) instead of silently disappearing from the chart.
      const countByCategory = {};
      categoryAgg.forEach((c) => {
        countByCategory[c._id || "Uncategorized"] = c.count;
      });
      const categoryDistribution = allCategories.map((c) => ({
        category: c.Category,
        count: countByCategory[c.Category] || 0,
      }));
      // Catch any product category that doesn't match a known category
      // doc (e.g. an old/renamed category) so its products aren't
      // dropped either.
      const knownNames = new Set(allCategories.map((c) => c.Category));
      categoryAgg.forEach((c) => {
        const name = c._id || "Uncategorized";
        if (!knownNames.has(name)) categoryDistribution.push({ category: name, count: c.count });
      });

      // Fill in every bucket in the requested range with 0 where there
      // was no signup, so the line chart shows a continuous day-by-day
      // (or month-by-month) trend instead of jumping straight between
      // the sparse points that actually had signups.
      const countByBucket = {};
      signupAgg.forEach((s) => {
        countByBucket[s._id] = s.count;
      });
      let signupsOverTime;
      if (period === "year") {
        // Unbounded range - just report every year that actually has data.
        signupsOverTime = signupAgg.map((s) => ({ date: s._id, count: s.count }));
      } else {
        const buckets = [];
        if (period === "month") {
          const y = filterYear || now.getFullYear();
          for (let m = 1; m <= 12; m++) buckets.push(`${y}-${String(m).padStart(2, "0")}`);
        } else {
          const cursor = new Date(rangeStart);
          while (cursor <= rangeEnd) {
            const y = cursor.getFullYear();
            const m = String(cursor.getMonth() + 1).padStart(2, "0");
            const d = String(cursor.getDate()).padStart(2, "0");
            buckets.push(`${y}-${m}-${d}`);
            cursor.setDate(cursor.getDate() + 1);
          }
        }
        signupsOverTime = buckets.map((b) => ({ date: b, count: countByBucket[b] || 0 }));
      }

      res.send({
        totalUsers: totalBuyers + totalSellers + totalAdmins,
        totalBuyers,
        totalSellers,
        totalAdmins,
        totalProducts,
        totalAvailable,
        totalBooked,
        totalAdvertised,
        totalSold,
        totalReported,
        totalOrders,
        completedOrders,
        incompleteOrders,
        cancelledOrders,
        totalAmountPaid,
        totalPaymentRemaining,
        totalCompanyEarnings,
        // Kept for backward compatibility with any older client still
        // reading this field name.
        totalSoldAmount: totalAmountPaid,
        categoryDistribution,
        signupsOverTime,
        signupPeriod: period,
        signupYears: signupYearsAgg.map((y) => y._id).filter(Boolean),
      });
    })
  );

  // ---- Revenue analytics for the admin dashboard - business-facing view:
  // growth/decline vs. the prior period, custom date-to-date filtering,
  // year-over-year comparison, and revenue broken down by category and
  // payment method.
  router.get(
    "/admin/analytics/revenue",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const now = new Date();

      // ---- Custom date-to-date range for the trend chart ----
      // Defaults to the last 30 days when nothing is specified, mirroring
      // the signup chart's default so the page isn't empty on first load.
      const granularity = ["day", "month", "year"].includes(req.query.granularity)
        ? req.query.granularity
        : "day";
      let rangeStart = req.query.from ? new Date(req.query.from) : null;
      let rangeEnd = req.query.to ? new Date(req.query.to) : null;
      if (rangeEnd) rangeEnd.setHours(23, 59, 59, 999);
      if (!rangeStart && !rangeEnd) {
        rangeEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        rangeStart = new Date(rangeEnd);
        if (granularity === "year") {
          rangeStart.setFullYear(rangeStart.getFullYear() - 6);
        } else if (granularity === "month") {
          rangeStart.setMonth(rangeStart.getMonth() - 11);
        } else {
          rangeStart.setDate(rangeStart.getDate() - 29);
        }
        rangeStart.setHours(0, 0, 0, 0);
      } else if (!rangeStart) {
        rangeStart = new Date(0);
      } else if (!rangeEnd) {
        rangeEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      }

      // Year picked for the year-over-year comparison chart (defaults to
      // the current year), compared against the year right before it.
      const compareYear = Number.isInteger(Number(req.query.year)) && req.query.year
        ? Number(req.query.year)
        : now.getFullYear();
      const previousCompareYear = compareYear - 1;

      const [payments, bookings, fees] = await Promise.all([
        paymentCollection.find({}).toArray(),
        bookingCollection.find({ isDemo: { $ne: true } }).toArray(),
        platformFeeCollection.find({}).toArray(),
      ]);

      // Attach the product category to each payment via its booking
      // record, so revenue can be broken down by category without a
      // second round trip from the client.
      const bookingById = {};
      bookings.forEach((b) => {
        bookingById[b._id.toString()] = b;
      });
      const enriched = payments.map((p) => ({
        ...p,
        price: Number(p.price) || 0,
        createdAt: p.createdAt ? new Date(p.createdAt) : null,
        category: bookingById[p.bookingId]?.category || "Uncategorized",
      }));

      // Platform fees (150tk per sale, 100tk per advertisement) are the
      // ONLY money BuyTop actually earns. Everything in `enriched` above -
      // deposits and full/remaining payments - is buyer money that
      // passes straight through to the seller and is never kept by the
      // platform, so it's tracked separately below as "gross payments"
      // rather than being counted as revenue.
      const enrichedFees = fees.map((f) => ({
        ...f,
        amount: Number(f.amount) || 0,
        createdAt: f.createdAt ? new Date(f.createdAt) : null,
        category: f.category || "Uncategorized",
      }));

      const sum = (list) => round2(list.reduce((s, p) => s + p.price, 0));
      const sumFees = (list) => round2(list.reduce((s, f) => s + f.amount, 0));

      const inRange = (d, start, end) => d && d >= start && d <= end;

      const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfThisMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      const startOfThisYear = new Date(now.getFullYear(), 0, 1);
      const endOfThisYear = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
      const startOfLastYear = new Date(now.getFullYear() - 1, 0, 1);
      const endOfLastYear = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999);

      // ---- Company earnings: actual BuyTop revenue (sale + ad fees) ----
      const saleFees = enrichedFees.filter((f) => f.type === "SaleFee");
      const adFees = enrichedFees.filter((f) => f.type === "AdFee");
      const totalEarnings = sumFees(enrichedFees);
      const saleFeeRevenue = sumFees(saleFees);
      const adFeeRevenue = sumFees(adFees);

      const earningsThisMonth = sumFees(enrichedFees.filter((f) => inRange(f.createdAt, startOfThisMonth, endOfThisMonth)));
      const earningsLastMonth = sumFees(enrichedFees.filter((f) => inRange(f.createdAt, startOfLastMonth, endOfLastMonth)));
      const earningsMomGrowthPct = pctChange(earningsThisMonth, earningsLastMonth);

      const earningsThisYear = sumFees(enrichedFees.filter((f) => inRange(f.createdAt, startOfThisYear, endOfThisYear)));
      const earningsLastYear = sumFees(enrichedFees.filter((f) => inRange(f.createdAt, startOfLastYear, endOfLastYear)));
      const earningsYoyGrowthPct = pctChange(earningsThisYear, earningsLastYear);

      const earningsCategoryTotals = {};
      enrichedFees.forEach((f) => {
        earningsCategoryTotals[f.category] = (earningsCategoryTotals[f.category] || 0) + f.amount;
      });
      const earningsByCategory = Object.entries(earningsCategoryTotals)
        .map(([category, total]) => ({ category, earnings: round2(total) }))
        .sort((a, b) => b.earnings - a.earnings);

      // Earnings trend, bucketed the same way as the gross-payments
      // trend below, over the same selected date range.
      const feeBucketed = {};
      enrichedFees
        .filter((f) => inRange(f.createdAt, rangeStart, rangeEnd))
        .forEach((f) => {
          const key = dateKeyOf(f.createdAt, granularity);
          feeBucketed[key] = (feeBucketed[key] || 0) + f.amount;
        });
      const earningsTrend = [];
      if (granularity === "year") {
        for (let y = rangeStart.getFullYear(); y <= rangeEnd.getFullYear(); y++) {
          earningsTrend.push({ date: `${y}`, earnings: round2(feeBucketed[`${y}`] || 0) });
        }
      } else if (granularity === "month") {
        const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
        while (cursor <= rangeEnd) {
          const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
          earningsTrend.push({ date: key, earnings: round2(feeBucketed[key] || 0) });
          cursor.setMonth(cursor.getMonth() + 1);
        }
      } else {
        const cursor = new Date(rangeStart);
        while (cursor <= rangeEnd) {
          const key = dateKeyOf(cursor, "day");
          earningsTrend.push({ date: key, earnings: round2(feeBucketed[key] || 0) });
          cursor.setDate(cursor.getDate() + 1);
        }
      }
      const earningsTrendTotal = round2(earningsTrend.reduce((s, t) => s + t.earnings, 0));
      const earningsRangeMs = rangeEnd.getTime() - rangeStart.getTime();
      const earningsPriorRangeEnd = new Date(rangeStart.getTime() - 1);
      const earningsPriorRangeStart = new Date(earningsPriorRangeEnd.getTime() - earningsRangeMs);
      const earningsPriorRangeTotal = sumFees(
        enrichedFees.filter((f) => inRange(f.createdAt, earningsPriorRangeStart, earningsPriorRangeEnd))
      );
      const earningsTrendGrowthPct = pctChange(earningsTrendTotal, earningsPriorRangeTotal);

      // Earnings year-over-year, same shape as the gross-payments version.
      const earningsMonthTotals = (year) => {
        const totals = new Array(12).fill(0);
        enrichedFees.forEach((f) => {
          if (f.createdAt && f.createdAt.getFullYear() === year) {
            totals[f.createdAt.getMonth()] += f.amount;
          }
        });
        return totals.map((v) => round2(v));
      };
      const earningsCurrentYearMonths = earningsMonthTotals(compareYear);
      const earningsPreviousYearMonths = earningsMonthTotals(previousCompareYear);
      const earningsYearOverYear = {
        year: compareYear,
        previousYear: previousCompareYear,
        months: MONTH_SHORT.map((name, i) => ({
          month: name,
          current: earningsCurrentYearMonths[i],
          previous: earningsPreviousYearMonths[i],
        })),
        currentYearTotal: round2(earningsCurrentYearMonths.reduce((s, v) => s + v, 0)),
        previousYearTotal: round2(earningsPreviousYearMonths.reduce((s, v) => s + v, 0)),
      };
      earningsYearOverYear.growthPct = pctChange(
        earningsYearOverYear.currentYearTotal,
        earningsYearOverYear.previousYearTotal
      );

      // ---- Gross payments: total money that has moved through the       ----
      // ---- platform (deposits + full payments). This is NOT company     ----
      // ---- revenue - it passes through to sellers - but it's still      ----
      // ---- useful to track transaction volume and payment-method mix.   ----
      const totalRevenue = sum(enriched);
      const totalTransactions = enriched.length;
      const depositRevenue = sum(enriched.filter((p) => p.type === "Deposit"));
      const fullRevenue = sum(enriched.filter((p) => p.type === "Full"));

      const paidBookings = bookings.filter((b) => b.status === "Paid");
      const avgOrderValue = paidBookings.length
        ? round2(paidBookings.reduce((s, b) => s + (Number(b.price) || 0), 0) / paidBookings.length)
        : 0;

      const revenueThisMonth = sum(enriched.filter((p) => inRange(p.createdAt, startOfThisMonth, endOfThisMonth)));
      const revenueLastMonth = sum(enriched.filter((p) => inRange(p.createdAt, startOfLastMonth, endOfLastMonth)));
      const momGrowthPct = pctChange(revenueThisMonth, revenueLastMonth);

      const revenueThisYear = sum(enriched.filter((p) => inRange(p.createdAt, startOfThisYear, endOfThisYear)));
      const revenueLastYear = sum(enriched.filter((p) => inRange(p.createdAt, startOfLastYear, endOfLastYear)));
      const yoyGrowthPct = pctChange(revenueThisYear, revenueLastYear);

      // Revenue by payment method (bKash / Cash), so the business can
      // see which rail actually brings the money in.
      const methodTotals = {};
      enriched.forEach((p) => {
        const key = p.method || "Other";
        methodTotals[key] = (methodTotals[key] || 0) + p.price;
      });
      const revenueByMethod = Object.entries(methodTotals)
        .map(([method, total]) => ({ method, total: round2(total) }))
        .sort((a, b) => b.total - a.total);

      // Revenue by product category - which categories are actually
      // driving sales, not just listings.
      const categoryTotals = {};
      enriched.forEach((p) => {
        categoryTotals[p.category] = (categoryTotals[p.category] || 0) + p.price;
      });
      const revenueByCategory = Object.entries(categoryTotals)
        .map(([category, total]) => ({ category, revenue: round2(total) }))
        .sort((a, b) => b.revenue - a.revenue);

      // ---- Trend chart: revenue bucketed over the selected date range ----
      const bucketed = {};
      enriched
        .filter((p) => inRange(p.createdAt, rangeStart, rangeEnd))
        .forEach((p) => {
          const key = dateKeyOf(p.createdAt, granularity);
          bucketed[key] = (bucketed[key] || 0) + p.price;
        });

      const trend = [];
      if (granularity === "year") {
        const cursor = new Date(rangeStart.getFullYear(), 0, 1);
        const endYear = rangeEnd.getFullYear();
        for (let y = cursor.getFullYear(); y <= endYear; y++) {
          trend.push({ date: `${y}`, revenue: round2(bucketed[`${y}`] || 0) });
        }
      } else if (granularity === "month") {
        const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
        while (cursor <= rangeEnd) {
          const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
          trend.push({ date: key, revenue: round2(bucketed[key] || 0) });
          cursor.setMonth(cursor.getMonth() + 1);
        }
      } else {
        const cursor = new Date(rangeStart);
        while (cursor <= rangeEnd) {
          const key = dateKeyOf(cursor, "day");
          trend.push({ date: key, revenue: round2(bucketed[key] || 0) });
          cursor.setDate(cursor.getDate() + 1);
        }
      }
      const trendTotal = round2(trend.reduce((s, t) => s + t.revenue, 0));
      // Compare the trend range against the immediately preceding range
      // of equal length, so "up" or "down" always has a clear baseline
      // even when the person has picked a custom from/to window.
      const rangeMs = rangeEnd.getTime() - rangeStart.getTime();
      const priorRangeEnd = new Date(rangeStart.getTime() - 1);
      const priorRangeStart = new Date(priorRangeEnd.getTime() - rangeMs);
      const priorRangeTotal = sum(enriched.filter((p) => inRange(p.createdAt, priorRangeStart, priorRangeEnd)));
      const trendGrowthPct = pctChange(trendTotal, priorRangeTotal);

      // ---- Year-over-year: revenue per month, this year vs. last ----
      const monthTotals = (year) => {
        const totals = new Array(12).fill(0);
        enriched.forEach((p) => {
          if (p.createdAt && p.createdAt.getFullYear() === year) {
            totals[p.createdAt.getMonth()] += p.price;
          }
        });
        return totals.map((v) => round2(v));
      };
      const currentYearMonths = monthTotals(compareYear);
      const previousYearMonths = monthTotals(previousCompareYear);
      const yearOverYear = {
        year: compareYear,
        previousYear: previousCompareYear,
        months: MONTH_SHORT.map((name, i) => ({
          month: name,
          current: currentYearMonths[i],
          previous: previousYearMonths[i],
        })),
        currentYearTotal: round2(currentYearMonths.reduce((s, v) => s + v, 0)),
        previousYearTotal: round2(previousYearMonths.reduce((s, v) => s + v, 0)),
      };
      yearOverYear.growthPct = pctChange(yearOverYear.currentYearTotal, yearOverYear.previousYearTotal);

      // Every year that has at least one payment on file, so the client
      // can populate a year picker without guessing.
      const revenueYears = Array.from(
        new Set(enriched.filter((p) => p.createdAt).map((p) => p.createdAt.getFullYear()))
      ).sort((a, b) => a - b);

      res.send({
        // ---- What BuyTop actually earns: the 150tk sale fee and 100tk
        // ad fee charged to sellers. This is real company revenue.
        companyEarnings: {
          totalEarnings,
          saleFeeRevenue,
          adFeeRevenue,
          saleCount: saleFees.length,
          adCount: adFees.length,
          saleFeeAmount: PLATFORM_FEES.SALE,
          adFeeAmount: PLATFORM_FEES.ADVERTISEMENT,
          earningsThisMonth,
          earningsLastMonth,
          earningsMomGrowthPct,
          earningsThisYear,
          earningsLastYear,
          earningsYoyGrowthPct,
        },
        earningsTrend,
        earningsTrendTotal,
        earningsTrendGrowthPct,
        earningsByCategory,
        earningsYearOverYear,

        // ---- Gross payments: total buyer money that has moved through
        // the platform (deposits + full/remaining payments). This is
        // pass-through money that belongs to sellers, NOT company
        // revenue - kept here for transaction-volume and
        // payment-method visibility only.
        grossPayments: {
          totalRevenue,
          totalTransactions,
          avgOrderValue,
          depositRevenue,
          fullRevenue,
          revenueThisMonth,
          revenueLastMonth,
          momGrowthPct,
          revenueThisYear,
          revenueLastYear,
          yoyGrowthPct,
          revenueByMethod,
        },
        trend,
        trendTotal,
        trendGrowthPct,
        granularity,
        revenueByCategory,
        yearOverYear,
        revenueYears,
      });
    })
  );

  // ---- Funnel: Booking -> Deposit Paid -> Fully Paid --------------------
  router.get(
    "/admin/analytics/funnel",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const [bookings, fullPayments] = await Promise.all([
        bookingCollection.find({ isDemo: { $ne: true } }).toArray(),
        paymentCollection.find({ type: "Full" }).toArray(),
      ]);
      const now = new Date();

      // Every booking that was ever created counts as "Booked",
      // including ones later cancelled - they did make it through this
      // first stage. (A booking cancelled before any deposit was paid is
      // deleted outright by design - see PATCH /myorders/:id - so
      // there's nothing left on file to count for that case.)
      const bookedCount = bookings.length;
      const depositPaidCount = bookings.filter((b) => b.depositPaid).length;
      const fullyPaidCount = bookings.filter((b) => b.status === "Paid").length;
      const rate = (num, den) => (den > 0 ? round2((num / den) * 100) : 0);

      // Deposit abandonment: bookings still sitting in "Awaiting
      // Deposit" (never cancelled either) after N days.
      const stillAwaitingDeposit = bookings.filter(
        (b) => !b.depositPaid && b.status !== "Cancelled" && b.createdAt
      );
      const depositAbandonment = [3, 7, 14].map((days) => ({
        days,
        count: stillAwaitingDeposit.filter((b) => daysBetween(new Date(b.createdAt), now) >= days).length,
      }));

      // Average booking -> full-payment time, using the Full payment's
      // own createdAt as the close moment.
      const fullPaymentByBooking = {};
      fullPayments.forEach((p) => {
        fullPaymentByBooking[p.bookingId] = p.createdAt ? new Date(p.createdAt) : null;
      });
      const closeDurations = bookings
        .filter((b) => b.status === "Paid" && b.createdAt && fullPaymentByBooking[b._id.toString()])
        .map((b) => daysBetween(new Date(b.createdAt), fullPaymentByBooking[b._id.toString()]));
      const avgDaysToClose = closeDurations.length
        ? round2(closeDurations.reduce((s, d) => s + d, 0) / closeDurations.length)
        : 0;

      res.send({
        funnel: [
          { stage: "Booked", count: bookedCount },
          { stage: "Deposit Paid", count: depositPaidCount },
          { stage: "Fully Paid", count: fullyPaidCount },
        ],
        conversionRates: {
          bookedToDeposit: rate(depositPaidCount, bookedCount),
          depositToFull: rate(fullyPaidCount, depositPaidCount),
          bookedToFull: rate(fullyPaidCount, bookedCount),
        },
        depositAbandonment,
        avgDaysToClose,
      });
    })
  );

  // ---- Seller leaderboard -------------------------------------------
  router.get(
    "/admin/analytics/sellers",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const [products, payments] = await Promise.all([
        productsCollection.find({ isDemo: { $ne: true } }).toArray(),
        paymentCollection.find({}).toArray(),
      ]);
      const productById = {};
      products.forEach((p) => {
        productById[p._id.toString()] = p;
      });

      const sellerStats = {};
      const ensure = (email, name) => {
        if (!sellerStats[email]) {
          sellerStats[email] = { email, name: name || email, revenue: 0, unitsSold: 0, sellDays: [] };
        }
        return sellerStats[email];
      };

      const countedAsSold = new Set();
      payments.forEach((p) => {
        const product = productById[p.productId];
        if (!product || !product.email) return;
        const stat = ensure(product.email, product.userName);
        stat.revenue += Number(p.price) || 0;
        if (p.type === "Full" && !countedAsSold.has(p.productId)) {
          countedAsSold.add(p.productId);
          stat.unitsSold += 1;
          const listedAt = idTimestamp(product);
          const soldAt = p.createdAt ? new Date(p.createdAt) : null;
          if (listedAt && soldAt) stat.sellDays.push(daysBetween(listedAt, soldAt));
        }
      });

      const leaderboard = Object.values(sellerStats)
        .map((s) => ({
          email: s.email,
          name: s.name,
          revenue: round2(s.revenue),
          unitsSold: s.unitsSold,
          avgDaysToSell: s.sellDays.length
            ? round2(s.sellDays.reduce((a, b) => a + b, 0) / s.sellDays.length)
            : null,
        }))
        .sort((a, b) => b.revenue - a.revenue);

      res.send({ leaderboard });
    })
  );

  // ---- Inventory health: sell-through, stale listings, advertised    --
  // ---- conversion, and asking/original price comparison              --
  router.get(
    "/admin/analytics/inventory",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const products = await productsCollection.find({ isDemo: { $ne: true } }).toArray();
      const now = new Date();
      const statusOf = (p) => String(p.status || "").toLowerCase();

      // Sell-through by category (sold / total listed), not just
      // revenue - a category can carry lots of listings but few actual
      // sales.
      const byCategory = {};
      products.forEach((p) => {
        const cat = p.category || "Uncategorized";
        if (!byCategory[cat]) byCategory[cat] = { category: cat, totalListed: 0, sold: 0 };
        byCategory[cat].totalListed += 1;
        if (statusOf(p) === "paid") byCategory[cat].sold += 1;
      });
      const categorySellThrough = Object.values(byCategory)
        .map((c) => ({ ...c, sellThroughPct: c.totalListed ? round2((c.sold / c.totalListed) * 100) : 0 }))
        .sort((a, b) => b.sellThroughPct - a.sellThroughPct);

      // Stale listings: still Available/Advertised, aged off the
      // ObjectId's own creation timestamp rather than the free-text
      // postDate string, so age is always reliable regardless of how
      // postDate was formatted.
      const stillListed = products.filter((p) => ["available", "advertised"].includes(statusOf(p)));
      const withAge = stillListed.map((p) => ({
        id: p._id,
        productName: p.productName,
        sellerEmail: p.email,
        category: p.category,
        resalePrice: Number(p.resalePrice) || 0,
        daysListed: daysBetween(idTimestamp(p), now),
      }));
      const staleBuckets = [14, 30, 60].map((days) => ({
        days,
        count: withAge.filter((p) => p.daysListed >= days).length,
      }));
      const staleListings = withAge
        .filter((p) => p.daysListed >= 14)
        .sort((a, b) => b.daysListed - a.daysListed)
        .slice(0, 25);

      // Advertised vs. non-advertised conversion, using the permanent
      // wasAdvertised flag (set by PATCH /addAdv/:id) rather than
      // current status, so a listing that sold after being advertised
      // still counts as an advertised conversion. Products advertised
      // before this flag existed won't be reflected here - only
      // advertising from now on is.
      const advertisedPool = products.filter((p) => p.wasAdvertised === true);
      const nonAdvertisedPool = products.filter((p) => p.wasAdvertised !== true);
      const poolStats = (pool) => ({
        listed: pool.length,
        sold: pool.filter((p) => statusOf(p) === "paid").length,
        conversionPct: pool.length
          ? round2((pool.filter((p) => statusOf(p) === "paid").length / pool.length) * 100)
          : 0,
      });
      const advertisedConversion = {
        advertised: poolStats(advertisedPool),
        nonAdvertised: poolStats(nonAdvertisedPool),
      };

      // Listed (resale/asking) price vs. the seller's own original
      // price. Buyers always pay exactly the listed resalePrice here -
      // there's no offer/negotiation step - so resalePrice already *is*
      // the real sale price for sold items; this compares what sellers
      // ask against what they originally paid, i.e. their markup,
      // rather than asking vs. what it actually sold for.
      const soldProducts = products.filter((p) => statusOf(p) === "paid");
      const avg = (list, key) =>
        list.length ? round2(list.reduce((s, p) => s + (Number(p[key]) || 0), 0) / list.length) : 0;
      const withBothPrices = soldProducts.filter((p) => Number(p.originalPrice) > 0);
      const avgMarkupPct = withBothPrices.length
        ? round2(
            withBothPrices.reduce(
              (s, p) => s + ((Number(p.resalePrice) - Number(p.originalPrice)) / Number(p.originalPrice)) * 100,
              0
            ) / withBothPrices.length
          )
        : 0;

      res.send({
        categorySellThrough,
        staleBuckets,
        staleListings,
        advertisedConversion,
        pricing: {
          avgOriginalPrice: avg(soldProducts, "originalPrice"),
          avgResalePrice: avg(soldProducts, "resalePrice"),
          avgMarkupPct,
        },
      });
    })
  );

  // ---- Buyers: new vs. returning revenue, repeat rate, top spenders --
  router.get(
    "/admin/analytics/buyers",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const bookings = await bookingCollection
        .find({ status: "Paid" })
        .sort({ createdAt: 1 })
        .toArray();

      const byBuyer = {};
      bookings.forEach((b) => {
        if (!byBuyer[b.email]) byBuyer[b.email] = { email: b.email, orders: 0, revenue: 0 };
        byBuyer[b.email].orders += 1;
        byBuyer[b.email].revenue += Number(b.price) || 0;
      });
      const buyersList = Object.values(byBuyer);
      const returningBuyers = buyersList.filter((b) => b.orders > 1);
      const newBuyers = buyersList.filter((b) => b.orders === 1);

      // "New" revenue = each buyer's first completed order; "returning"
      // = every order after that, walked in date order so a buyer's
      // first purchase always counts as new even if they bought again
      // later.
      let newRevenue = 0;
      let returningRevenue = 0;
      const seen = new Set();
      bookings.forEach((b) => {
        const price = Number(b.price) || 0;
        if (seen.has(b.email)) {
          returningRevenue += price;
        } else {
          newRevenue += price;
          seen.add(b.email);
        }
      });

      const topBuyers = buyersList
        .map((b) => ({ email: b.email, totalSpend: round2(b.revenue), orders: b.orders }))
        .sort((a, b) => b.totalSpend - a.totalSpend)
        .slice(0, 20);

      res.send({
        newVsReturning: {
          newRevenue: round2(newRevenue),
          returningRevenue: round2(returningRevenue),
          newBuyers: newBuyers.length,
          returningBuyers: returningBuyers.length,
        },
        repeatPurchaseRate: buyersList.length ? round2((returningBuyers.length / buyersList.length) * 100) : 0,
        totalBuyers: buyersList.length,
        topBuyers,
      });
    })
  );

  // ---- Cancellations: rate over time + revenue retained on them  ----
  router.get(
    "/admin/analytics/cancellations",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const bookings = await bookingCollection.find({ isDemo: { $ne: true } }).toArray();
      const cancelled = bookings.filter((b) => b.status === "Cancelled");
      // Only "closed" outcomes (fully paid or cancelled) are counted as
      // the denominator - a booking still in progress hasn't had a
      // chance to become either yet.
      const closed = bookings.filter((b) => b.status === "Cancelled" || b.status === "Paid");

      const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const byMonth = {};
      closed.forEach((b) => {
        const raw = b.status === "Cancelled" ? b.cancelledAt || b.createdAt : b.createdAt;
        const d = raw ? new Date(raw) : null;
        if (!d || isNaN(d.getTime())) return;
        const key = monthKey(d);
        if (!byMonth[key]) byMonth[key] = { cancelled: 0, total: 0 };
        byMonth[key].total += 1;
        if (b.status === "Cancelled") byMonth[key].cancelled += 1;
      });
      const cancellationRateOverTime = Object.entries(byMonth)
        .map(([month, v]) => ({
          month,
          cancelled: v.cancelled,
          total: v.total,
          ratePct: v.total ? round2((v.cancelled / v.total) * 100) : 0,
        }))
        .sort((a, b) => (a.month < b.month ? -1 : 1));

      // Deposits (and, for orders already fully paid before being
      // cancelled, the full payment too) are non-refundable - there's
      // no refund call anywhere in this app - so this money was
      // collected and kept even though the order didn't go through.
      // Note: only cancellations approved since cancelled bookings
      // started being kept on file (rather than deleted) show up here -
      // anything cancelled before that change isn't recoverable.
      const retainedDepositRevenue = round2(
        cancelled.filter((b) => b.depositPaid).reduce((s, b) => s + (Number(b.depositAmount) || 0), 0)
      );
      const retainedFullRevenue = round2(
        cancelled.filter((b) => b.preCancelStatus === "Paid").reduce((s, b) => s + (Number(b.price) || 0), 0)
      );

      res.send({
        totalCancellations: cancelled.length,
        cancellationRateOverall: closed.length ? round2((cancelled.length / closed.length) * 100) : 0,
        cancellationRateOverTime,
        retainedDepositRevenue,
        retainedFullRevenue,
        retainedRevenueTotal: round2(retainedDepositRevenue + retainedFullRevenue),
      });
    })
  );

  // ---- Pipeline: expected revenue + a rough next-30-day projection --
  router.get(
    "/admin/analytics/pipeline",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const [pendingBookings, payments] = await Promise.all([
        bookingCollection.find({ status: { $in: ["Awaiting Deposit", "Booked"] }, isDemo: { $ne: true } }).toArray(),
        paymentCollection.find({}).toArray(),
      ]);

      // Expected revenue: the balance still owed on every order that's
      // booked but not yet fully paid (or cancelled).
      const expectedRevenue = round2(
        pendingBookings.reduce((sum, b) => {
          const price = Number(b.price) || 0;
          const depositAmount = b.depositPaid ? Number(b.depositAmount || 0) : 0;
          return sum + Math.max(price - depositAmount, 0);
        }, 0)
      );

      // Simple next-30-days projection: average daily revenue over the
      // last 30 days, nudged by the growth rate between the two 15-day
      // halves of that window. A rough trend extrapolation, not a
      // forecasting model - the growth nudge is clamped so one
      // unusually large or quiet day can't swing it wildly.
      const now = new Date();
      const start30 = new Date(now);
      start30.setDate(start30.getDate() - 29);
      start30.setHours(0, 0, 0, 0);
      const midpoint = new Date(now);
      midpoint.setDate(midpoint.getDate() - 14);

      const last30 = payments.filter((p) => {
        const d = p.createdAt ? new Date(p.createdAt) : null;
        return d && d >= start30 && d <= now;
      });
      const firstHalfTotal = last30
        .filter((p) => new Date(p.createdAt) < midpoint)
        .reduce((s, p) => s + (Number(p.price) || 0), 0);
      const secondHalfTotal = last30
        .filter((p) => new Date(p.createdAt) >= midpoint)
        .reduce((s, p) => s + (Number(p.price) || 0), 0);
      const last30Total = firstHalfTotal + secondHalfTotal;

      let growthRate = firstHalfTotal > 0 ? (secondHalfTotal - firstHalfTotal) / firstHalfTotal : 0;
      growthRate = Math.max(-0.5, Math.min(1, growthRate));
      const projectedNext30Days = round2(Math.max(0, (last30Total / 30) * 30 * (1 + growthRate)));

      res.send({
        expectedRevenue,
        pendingOrders: pendingBookings.length,
        last30DaysRevenue: round2(last30Total),
        projectedNext30Days,
      });
    })
  );

  // ---- Reported-items trend -------------------------------------------
  router.get(
    "/admin/analytics/reports-trend",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const reports = await reportCollection.find({}).toArray();
      const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const byMonth = {};
      reports.forEach((r) => {
        // Report documents don't carry their own createdAt, and the
        // upsert-by-productId route means re-reporting an
        // already-reported product doesn't reset anything - so the
        // doc's own _id timestamp (from when it was first filed) is
        // used instead.
        const d = idTimestamp(r);
        if (!d) return;
        const key = monthKey(d);
        byMonth[key] = (byMonth[key] || 0) + 1;
      });
      const trend = Object.entries(byMonth)
        .map(([month, count]) => ({ month, count }))
        .sort((a, b) => (a.month < b.month ? -1 : 1));
      res.send({ trend, totalReported: reports.length });
    })
  );

  // ---- CSV export: revenue (payments), orders (bookings), or fees ----
  const csvEscape = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const toCSV = (rows, columns) => {
    const header = columns.map((c) => csvEscape(c.label)).join(",");
    const lines = rows.map((row) => columns.map((c) => csvEscape(c.value(row))).join(","));
    return [header, ...lines].join("\r\n");
  };

  router.get(
    "/admin/analytics/export",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const type = ["orders", "fees"].includes(req.query.type) ? req.query.type : "revenue";

      if (type === "fees") {
        const fees = await platformFeeCollection.find({}).sort({ createdAt: -1 }).toArray();
        const csv = toCSV(fees, [
          { label: "Fee ID", value: (f) => f._id },
          { label: "Type", value: (f) => (f.type === "SaleFee" ? "Sale Fee" : "Advertisement Fee") },
          { label: "Amount", value: (f) => f.amount },
          { label: "Seller Email", value: (f) => f.sellerEmail },
          { label: "Category", value: (f) => f.category },
          { label: "Product ID", value: (f) => f.productId },
          { label: "Booking ID", value: (f) => f.bookingId || "" },
          { label: "Date", value: (f) => (f.createdAt ? new Date(f.createdAt).toISOString() : "") },
        ]);
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="buytop-company-earnings-${Date.now()}.csv"`);
        return res.send(csv);
      }

      if (type === "orders") {
        const bookings = await bookingCollection.find({ isDemo: { $ne: true } }).sort({ createdAt: -1 }).toArray();
        const csv = toCSV(bookings, [
          { label: "Booking ID", value: (b) => b._id },
          { label: "Product", value: (b) => b.productName },
          { label: "Category", value: (b) => b.category },
          { label: "Buyer Email", value: (b) => b.email },
          { label: "Price", value: (b) => b.price },
          { label: "Deposit Amount", value: (b) => b.depositAmount },
          { label: "Deposit Paid", value: (b) => (b.depositPaid ? "Yes" : "No") },
          { label: "Status", value: (b) => b.status },
          { label: "Booked At", value: (b) => (b.createdAt ? new Date(b.createdAt).toISOString() : "") },
          { label: "Cancelled At", value: (b) => (b.cancelledAt ? new Date(b.cancelledAt).toISOString() : "") },
        ]);
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="buytop-orders-${Date.now()}.csv"`);
        return res.send(csv);
      }

      const payments = await paymentCollection.find({}).sort({ createdAt: -1 }).toArray();
      const csv = toCSV(payments, [
        { label: "Payment ID", value: (p) => p._id },
        { label: "Booking ID", value: (p) => p.bookingId },
        { label: "Buyer Email", value: (p) => p.buyerEmail },
        { label: "Type", value: (p) => p.type },
        { label: "Method", value: (p) => p.method },
        { label: "Amount", value: (p) => p.price },
        { label: "Transaction ID", value: (p) => p.transactionId },
        { label: "Date", value: (p) => (p.createdAt ? new Date(p.createdAt).toISOString() : "") },
      ]);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="buytop-revenue-${Date.now()}.csv"`);
      res.send(csv);
    })
  );

  return router;
}

module.exports = createAdminAnalyticsRoutes;
