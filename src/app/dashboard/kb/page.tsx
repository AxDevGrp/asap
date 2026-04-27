'use client';

import { useState, useEffect, useCallback } from 'react';

interface KBArticle {
  id: string;
  title: string;
  content: string;
  product: string;
  tenant_id: string | null;
  created_at: string;
  updated_at: string;
}

interface KBFormData {
  title: string;
  content: string;
}

export default function KBPage() {
  const [articles, setArticles] = useState<KBArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [tenantId, setTenantId] = useState<string | null>(null);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<KBFormData>({ title: '', content: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Fetch current tenant from session
  const fetchTenant = useCallback(async () => {
    const res = await fetch('/api/me/tenant');
    if (res.ok) {
      const data = await res.json();
      setTenantId(data.tenantId);
    }
  }, []);

  const fetchArticles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/kb');
      if (res.ok) {
        const data = await res.json();
        setArticles(data.articles ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTenant();
    fetchArticles();
  }, [fetchTenant, fetchArticles]);

  function openCreate() {
    setEditingId(null);
    setForm({ title: '', content: '' });
    setError(null);
    setShowForm(true);
  }

  function openEdit(article: KBArticle) {
    setEditingId(article.id);
    setForm({ title: article.title, content: article.content });
    setError(null);
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.title.trim() || !form.content.trim()) {
      setError('Title and content are required');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (editingId) {
        // Update
        const res = await fetch(`/api/kb?id=${editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error ?? 'Update failed');
        }
      } else {
        // Create — use tenant slug as product if available
        const res = await fetch('/api/kb', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...form, product: 'unknown', tenant_id: tenantId }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error ?? 'Create failed');
        }
      }

      setShowForm(false);
      fetchArticles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/kb?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      setDeleteConfirm(null);
      fetchArticles();
    } catch {
      setError('Failed to delete article');
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Knowledge Base</h1>
          <p className="text-sm text-gray-500 mt-1">
            AI training articles — {articles.length} total
          </p>
        </div>
        <button
          onClick={openCreate}
          className="bg-gray-900 text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-gray-700 transition-colors"
        >
          + Add Article
        </button>
      </div>

      {/* Error banner */}
      {error && !showForm && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 mb-4 text-sm">
          {error}
        </div>
      )}

      {/* Inline form */}
      {showForm && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">
            {editingId ? 'Edit Article' : 'New Article'}
          </h2>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 mb-4 text-sm">
              {error}
            </div>
          )}

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="e.g. How to reset your password"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-1">Content</label>
            <textarea
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              placeholder="Write the knowledge base article here. Be detailed — the AI will use this to answer customer questions."
              rows={10}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-900 resize-y"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="bg-gray-900 text-white text-sm font-medium px-5 py-2 rounded-md hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? 'Saving…' : editingId ? 'Update Article' : 'Create Article'}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="text-sm text-gray-600 hover:text-gray-900 px-3 py-2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Articles list */}
      {loading ? (
        <div className="text-center py-12 text-gray-400 text-sm">Loading articles…</div>
      ) : articles.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg px-6 py-16 text-center">
          <div className="text-4xl mb-4">📚</div>
          <h3 className="font-semibold text-gray-900 mb-2">No articles yet</h3>
          <p className="text-sm text-gray-500 mb-6">
            Add knowledge base articles to train the AI on your product.
          </p>
          <button
            onClick={openCreate}
            className="bg-gray-900 text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-gray-700 transition-colors"
          >
            Add your first article
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {articles.map((article) => (
            <div
              key={article.id}
              className="bg-white border border-gray-200 rounded-lg p-5"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="font-medium text-gray-900">{article.title}</h3>
                  <p className="text-sm text-gray-500 mt-1 line-clamp-2">{article.content}</p>
                  <div className="text-xs text-gray-400 mt-2">
                    Updated {new Date(article.updated_at).toLocaleDateString()}
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => openEdit(article)}
                    className="text-sm text-gray-600 hover:text-gray-900 px-3 py-1.5 rounded-md hover:bg-gray-100 transition-colors"
                  >
                    Edit
                  </button>

                  {deleteConfirm === article.id ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-red-600">Confirm?</span>
                      <button
                        onClick={() => handleDelete(article.id)}
                        className="text-sm text-red-600 hover:text-red-800 px-2 py-1 rounded hover:bg-red-50"
                      >
                        Yes
                      </button>
                      <button
                        onClick={() => setDeleteConfirm(null)}
                        className="text-sm text-gray-500 px-2 py-1 rounded hover:bg-gray-100"
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeleteConfirm(article.id)}
                      className="text-sm text-red-500 hover:text-red-700 px-3 py-1.5 rounded-md hover:bg-red-50 transition-colors"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
