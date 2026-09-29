'use strict';

/**
 * Offset pagination with hard bounds.
 *
 * `limit` is clamped so a client cannot ask for 1,000,000 documents and
 * exhaust the server, and `page` cannot go below 1.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parsePagination(query = {}) {
  const rawLimit = Number.parseInt(query.limit, 10);
  const rawPage = Number.parseInt(query.page, 10);

  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  return { limit, page, skip: (page - 1) * limit };
}

function paginated(items, total, { page, limit }) {
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  };
}

module.exports = { parsePagination, paginated, DEFAULT_LIMIT, MAX_LIMIT };
