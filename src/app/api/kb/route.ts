// Knowledge Base CRUD API
// GET  /api/kb?product=strk     — list articles
// POST /api/kb                  — add article (auto-embeds)
// DELETE /api/kb?id=<uuid>      — delete article

import { NextRequest, NextResponse } from 'next/server';
import { createKBArticle, listKBArticles, deleteKBArticle } from '@/lib/db';

export async function GET(request: NextRequest) {
  const product = request.nextUrl.searchParams.get('product') ?? undefined;
  const articles = await listKBArticles(product);
  return NextResponse.json({ articles, count: articles.length });
}

export async function POST(request: NextRequest) {
  let body: { product?: string; title?: string; content?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { product, title, content } = body;
  if (!product || !title || !content) {
    return NextResponse.json(
      { error: 'Missing required fields: product, title, content' },
      { status: 400 }
    );
  }

  const validProducts = ['strk', 'cashpile', 'dailypost', 'unknown'];
  if (!validProducts.includes(product)) {
    return NextResponse.json(
      { error: `Invalid product. Must be one of: ${validProducts.join(', ')}` },
      { status: 400 }
    );
  }

  const article = await createKBArticle({ product, title, content });
  if (!article) {
    return NextResponse.json({ error: 'Failed to create article' }, { status: 500 });
  }
  return NextResponse.json({ article }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'Missing required param: id' }, { status: 400 });
  }

  const ok = await deleteKBArticle(id);
  if (!ok) {
    return NextResponse.json({ error: 'Delete failed or article not found' }, { status: 404 });
  }
  return NextResponse.json({ deleted: id });
}
