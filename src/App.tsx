import React, { useEffect, useState } from 'react';
import { Search, Filter, RefreshCw, ExternalLink, ShieldAlert, History, ChevronDown, ChevronUp, Download, Newspaper, LogIn, LogOut, User as UserIcon } from 'lucide-react';
import { format } from 'date-fns';
import Markdown from 'react-markdown';
import { GoogleGenAI } from '@google/genai';
import { auth, signInWithGoogle, logout, db, handleFirestoreError, OperationType } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { collection, query, orderBy, limit, onSnapshot, where, getDocs, Timestamp, writeBatch, doc, setDoc, getDoc } from 'firebase/firestore';
import { ErrorBoundary } from './components/ErrorBoundary';

interface Sanction {
  id: string;
  name: string;
  type: string;
  source: string;
  date_updated: string;
  action: string;
  url_source: string;
  profile_data?: string;
}

interface SyncHistory {
  id: string;
  source: string;
  sync_date: string;
  added_count: number;
  removed_count: number;
}

function SanctionApp() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [sanctions, setSanctions] = useState<Sanction[]>([]);
  const [syncHistory, setSyncHistory] = useState<SyncHistory[]>([]);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [activeTab, setActiveTab] = useState<'feed' | 'history'>('feed');
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [adverseMedia, setAdverseMedia] = useState<Record<string, { loading: boolean, data?: { summary: string, articles: any[] }, error?: string }>>({});
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      return;
    }
    
    const checkAdmin = async () => {
      if (user.email === 'saravanansivakami30@gmail.com') {
        setIsAdmin(true);
        return;
      }
      
      try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        if (userDoc.exists() && userDoc.data()?.role === 'admin') {
          setIsAdmin(true);
        }
      } catch (e) {
        console.error('Error checking admin status:', e);
      }
    };
    
    checkAdmin();
  }, [user]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  const fetchSanctions = async () => {
    if (!user) return;
    setLoading(true);
    try {
      let q = query(collection(db, 'sanctions'), orderBy('date_updated', 'desc'), limit(100));
      
      if (sourceFilter) {
        q = query(collection(db, 'sanctions'), where('source', '==', sourceFilter), orderBy('date_updated', 'desc'), limit(100));
      }
      
      if (typeFilter) {
        q = query(q, where('type', '==', typeFilter));
      }
      
      if (actionFilter) {
        q = query(q, where('action', '==', actionFilter));
      }
      
      const snapshot = await getDocs(q);
      let data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Sanction));
      
      if (search) {
        const searchLower = search.toLowerCase();
        data = data.filter(s => s.name.toLowerCase().includes(searchLower));
      }
      
      setSanctions(data);
    } catch (error) {
      console.error('Failed to fetch sanctions', error);
      setSanctions([]);
    } finally {
      setLoading(false);
    }
  };

  // Real-time sync history from Firestore
  useEffect(() => {
    if (!user || !authReady) return;

    const q = query(collection(db, 'sync_history'), orderBy('sync_date', 'desc'), limit(20));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const history = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as SyncHistory));
      setSyncHistory(history);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'sync_history');
    });

    return () => unsubscribe();
  }, [user, authReady]);

  const [syncStatus, setSyncStatus] = useState<string>('');

  const processDelta = async (source: string, currentItems: any[]) => {
    const today = Timestamp.now();
    const sanctionsRef = collection(db, 'sanctions');
    const q = query(sanctionsRef, where('source', '==', source));
    const snapshot = await getDocs(q);
    
    const existingMap = new Map<string, string>();
    snapshot.forEach(doc => {
      const data = doc.data();
      existingMap.set(data.id, data.action);
    });
    
    let addedCount = 0;
    let removedCount = 0;
    const CHUNK_SIZE = 200; // Reduced chunk size
    
    // Add/Update
    for (let i = 0; i < currentItems.length; i += CHUNK_SIZE) {
      const batch = writeBatch(db);
      const chunk = currentItems.slice(i, i + CHUNK_SIZE);
      
      for (const item of chunk) {
        const docId = item.id.replace(/\//g, '_');
        const docRef = doc(db, 'sanctions', docId);
        
        if (!existingMap.has(item.id)) {
          batch.set(docRef, { ...item, date_updated: today, action: 'Listed' });
          addedCount++;
        } else if (existingMap.get(item.id) === 'Delisted') {
          batch.update(docRef, { action: 'Listed', date_updated: today, profile_data: item.profile_data || null });
          addedCount++;
        } else {
          batch.update(docRef, { profile_data: item.profile_data || null });
        }
      }
      await batch.commit();
      // Small delay to prevent resource exhaustion
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Delist
    const currentIds = new Set(currentItems.map(i => i.id));
    const delistedItems = Array.from(existingMap.entries()).filter(([id, action]) => !currentIds.has(id) && action !== 'Delisted');
    
    for (let i = 0; i < delistedItems.length; i += CHUNK_SIZE) {
      const batch = writeBatch(db);
      const chunk = delistedItems.slice(i, i + CHUNK_SIZE);
      for (const [id] of chunk) {
        const docId = id.replace(/\//g, '_');
        const docRef = doc(db, 'sanctions', docId);
        batch.update(docRef, { action: 'Delisted', date_updated: today });
        removedCount++;
      }
      await batch.commit();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // History
    const historyRef = doc(collection(db, 'sync_history'));
    await setDoc(historyRef, { source, sync_date: today, added_count: addedCount, removed_count: removedCount });
  };

  const handleSync = async () => {
    if (!isAdmin) {
      alert('Only admins can perform sync operations.');
      return;
    }

    setSyncing(true);
    setSyncStatus('Starting sync...');
    try {
      const sources = ['un', 'us', 'mha', 'fiu'];
      let successCount = 0;
      let failCount = 0;

      for (const source of sources) {
        try {
          setSyncStatus(`Fetching ${source.toUpperCase()} data...`);
          const res = await fetch(`/api/scrape/${source}`);
          if (!res.ok) {
            const errorData = await res.json();
            throw new Error(errorData.error || 'Fetch failed');
          }
          const data = await res.json();
          
          setSyncStatus(`Updating ${source.toUpperCase()} in Firestore...`);
          const sourceName = source === 'mha' ? 'MHA India' : (source === 'us' ? 'US' : (source === 'un' ? 'UN' : 'FIU-IND'));
          await processDelta(sourceName, data);
          
          successCount++;
        } catch (err: any) {
          console.error(`${source.toUpperCase()} sync failed:`, err);
          failCount++;
        }
      }

      setSyncStatus('Sync complete!');
      if (failCount === 0) {
        alert('Sync completed successfully for all sources!');
      } else if (successCount > 0) {
        alert(`Sync partially successful. ${successCount} sources synced, ${failCount} failed. Check console for details.`);
      } else {
        alert('Sync failed for all sources. Check console for details.');
      }
      await fetchSanctions();
    } catch (error: any) {
      console.error('Global sync error:', error);
      alert(`Global sync error: ${error.message}`);
    } finally {
      setSyncing(false);
      setSyncStatus('');
    }
  };

  const handleSignIn = async () => {
    try {
      await signInWithGoogle();
    } catch (error: any) {
      console.error('Sign in failed:', error);
      alert(`Sign in failed: ${error.message}. If you are on a new domain (like Vercel), make sure to add it to "Authorized Domains" in the Firebase Console.`);
    }
  };

  const fetchAdverseMedia = async (id: string, name: string) => {
    setAdverseMedia(prev => ({ ...prev, [id]: { loading: true } }));
    try {
      // Use the environment variable provided by the platform or Vercel
      const apiKey = import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('Gemini API key is not configured.');
      
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Search for recent adverse media, news articles, or official reports regarding financial crime, terrorism, sanctions, or illegal activities for the entity or individual named "${name}". Summarize the findings briefly.`,
        config: {
          tools: [{ googleSearch: {} }],
        },
      });

      const text = response.text || '';
      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      
      const articles = chunks
        .filter((chunk: any) => chunk.web?.uri && chunk.web?.title)
        .map((chunk: any) => ({
          title: chunk.web.title,
          url: chunk.web.uri
        }))
        .slice(0, 10);

      const data = { summary: text, articles };
      setAdverseMedia(prev => ({ ...prev, [id]: { loading: false, data } }));
    } catch (error: any) {
      setAdverseMedia(prev => ({ ...prev, [id]: { loading: false, error: error.message } }));
    }
  };

  useEffect(() => {
    if (user) {
      fetchSanctions();
    }
  }, [user, sourceFilter, typeFilter, actionFilter]);

  // Debounce search
  useEffect(() => {
    if (!user) return;
    const timer = setTimeout(() => {
      fetchSanctions();
    }, 300);
    return () => clearTimeout(timer);
  }, [search, user]);

  const formatDate = (date: any) => {
    if (!date) return 'N/A';
    // Handle Firestore Timestamps
    if (date.seconds) {
      return format(new Date(date.seconds * 1000), 'MMM d, yyyy HH:mm');
    }
    // Handle ISO strings or Date objects
    return format(new Date(date), 'MMM d, yyyy HH:mm');
  };

  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <RefreshCw className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full border border-slate-200">
          <div className="flex justify-center mb-6">
            <div className="bg-red-100 p-4 rounded-2xl">
              <ShieldAlert className="w-12 h-12 text-red-600" />
            </div>
          </div>
          <h2 className="text-2xl font-bold text-center text-slate-900 mb-2">AML Sanction Aggregator</h2>
          <p className="text-slate-500 text-center mb-8">
            Please sign in with your Google account to access the sanction lists and adverse media screening tool.
          </p>
          <button
            onClick={handleSignIn}
            className="w-full flex items-center justify-center gap-3 bg-slate-900 text-white py-3.5 rounded-xl font-medium hover:bg-slate-800 transition-all shadow-lg hover:shadow-slate-200"
          >
            <LogIn className="w-5 h-5" />
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-red-100 p-2 rounded-lg">
              <ShieldAlert className="w-6 h-6 text-red-600" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 hidden sm:block">AML Aggregator</h1>
          </div>
          
          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-2 mr-4 px-3 py-1.5 bg-slate-50 rounded-lg border border-slate-200">
              <UserIcon className="w-4 h-4 text-slate-400" />
              <span className="text-xs font-medium text-slate-600">{user.email}</span>
            </div>
            
            <a
              href="/api/sanctions/export"
              download="sanctions_data.csv"
              className="flex items-center gap-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">Export</span>
            </a>
            
            <button
              onClick={handleSync}
              disabled={syncing}
              className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{syncing ? (syncStatus || 'Syncing...') : 'Sync Now'}</span>
            </button>

            <button
              onClick={logout}
              className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              title="Logout"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-col md:flex-row gap-4 mb-8">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder="Search by name (e.g., John Doe)..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent shadow-sm"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="bg-white border border-slate-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
            >
              <option value="">All Sources</option>
              <option value="UN">UN Security Council</option>
              <option value="US">US OFAC</option>
              <option value="MHA India">MHA India</option>
              <option value="FIU-IND">FIU-IND</option>
            </select>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="bg-white border border-slate-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
            >
              <option value="">All Types</option>
              <option value="Individual">Individual</option>
              <option value="Entity">Entity</option>
              <option value="Vessel">Vessel</option>
            </select>
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="bg-white border border-slate-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
            >
              <option value="">All Actions</option>
              <option value="Listed">Listed</option>
              <option value="Delisted">Delisted</option>
            </select>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="border-b border-slate-200 flex">
            <button
              onClick={() => setActiveTab('feed')}
              className={`flex-1 py-4 text-sm font-medium text-center border-b-2 transition-colors ${
                activeTab === 'feed' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
              }`}
            >
              Live Feed
            </button>
            <button
              onClick={() => setActiveTab('history')}
              className={`flex-1 py-4 text-sm font-medium text-center border-b-2 transition-colors flex items-center justify-center gap-2 ${
                activeTab === 'history' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
              }`}
            >
              <History className="w-4 h-4" />
              Sync History
            </button>
          </div>

          {activeTab === 'feed' ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="px-6 py-4 font-medium">Name</th>
                    <th className="px-6 py-4 font-medium">Type</th>
                    <th className="px-6 py-4 font-medium">Source</th>
                    <th className="px-6 py-4 font-medium">Action</th>
                    <th className="px-6 py-4 font-medium">Date Updated</th>
                    <th className="px-6 py-4 font-medium text-right">Link</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {loading ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                        <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2" />
                        Loading sanctions...
                      </td>
                    </tr>
                  ) : sanctions.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                        No sanctions found matching your criteria.
                      </td>
                    </tr>
                  ) : (
                    sanctions.map((sanction) => (
                      <React.Fragment key={sanction.id}>
                        <tr 
                          className="hover:bg-slate-50 transition-colors cursor-pointer"
                          onClick={() => setExpandedRow(expandedRow === sanction.id ? null : sanction.id)}
                        >
                          <td className="px-6 py-4 font-medium text-slate-900 flex items-center gap-2">
                            {expandedRow === sanction.id ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                            {sanction.name}
                          </td>
                          <td className="px-6 py-4">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              sanction.type === 'Individual' ? 'bg-blue-100 text-blue-800' :
                              sanction.type === 'Entity' ? 'bg-purple-100 text-purple-800' :
                              'bg-amber-100 text-amber-800'
                            }`}>
                              {sanction.type}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-800 border border-slate-200">
                              {sanction.source}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              sanction.action === 'Listed' ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'
                            }`}>
                              {sanction.action}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-slate-500">
                            {formatDate(sanction.date_updated)}
                          </td>
                          <td className="px-6 py-4 text-right">
                            <a
                              href={sanction.url_source}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center justify-center p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                              title="View Source"
                            >
                              <ExternalLink className="w-4 h-4" />
                            </a>
                          </td>
                        </tr>
                        {expandedRow === sanction.id && (
                          <tr className="bg-slate-50 border-b border-slate-200">
                            <td colSpan={6} className="px-6 py-4">
                              <div className="text-sm text-slate-700 grid grid-cols-1 md:grid-cols-2 gap-4">
                                {sanction.profile_data ? (
                                  Object.entries(JSON.parse(sanction.profile_data)).map(([key, value]) => {
                                    if (!value) return null;
                                    return (
                                      <div key={key} className="flex flex-col">
                                        <span className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">
                                          {key.replace(/_/g, ' ')}
                                        </span>
                                        <span className="text-slate-900">{String(value)}</span>
                                      </div>
                                    );
                                  })
                                ) : (
                                  <div className="text-slate-500 italic">No additional profile information available.</div>
                                )}
                              </div>
                              
                              <div className="mt-6 pt-6 border-t border-slate-200">
                                <div className="flex justify-between items-center mb-4">
                                  <h4 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                                    <Newspaper className="w-4 h-4 text-slate-500" />
                                    Adverse Media Check
                                  </h4>
                                  <button 
                                    onClick={() => fetchAdverseMedia(sanction.id, sanction.name)}
                                    disabled={adverseMedia[sanction.id]?.loading}
                                    className="flex items-center gap-2 bg-red-50 text-red-700 hover:bg-red-100 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                                  >
                                    <Search className="w-4 h-4" />
                                    {adverseMedia[sanction.id]?.loading ? 'Searching...' : 'View Adverse Media'}
                                  </button>
                                </div>
                                
                                {adverseMedia[sanction.id]?.error && (
                                  <div className="text-sm text-red-600 bg-red-50 p-3 rounded-lg">
                                    {adverseMedia[sanction.id].error}
                                  </div>
                                )}
                                
                                {adverseMedia[sanction.id]?.data && (
                                  <div className="space-y-4">
                                    <div className="text-sm text-slate-700 bg-white border border-slate-200 p-4 rounded-lg leading-relaxed markdown-body">
                                      <Markdown>{adverseMedia[sanction.id].data!.summary}</Markdown>
                                    </div>
                                    
                                    {adverseMedia[sanction.id].data!.articles.length > 0 && (
                                      <div>
                                        <h5 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Source Articles</h5>
                                        <ul className="space-y-2">
                                          {adverseMedia[sanction.id].data!.articles.map((article, idx) => (
                                            <li key={idx}>
                                              <a href={article.url} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:text-blue-800 hover:underline flex items-start gap-2">
                                                <ExternalLink className="w-4 h-4 mt-0.5 flex-shrink-0" />
                                                <span>{article.title}</span>
                                              </a>
                                            </li>
                                          ))}
                                        </ul>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="px-6 py-4 font-medium">Date</th>
                    <th className="px-6 py-4 font-medium">Source</th>
                    <th className="px-6 py-4 font-medium">Added</th>
                    <th className="px-6 py-4 font-medium">Removed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {syncHistory.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-6 py-12 text-center text-slate-500">
                        No sync history available. Click "Sync Now" to fetch data.
                      </td>
                    </tr>
                  ) : (
                    syncHistory.map((history) => (
                      <tr key={history.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4 text-slate-900 font-medium">
                          {formatDate(history.sync_date)}
                        </td>
                        <td className="px-6 py-4">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-800 border border-slate-200">
                            {history.source}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-red-600 font-medium">+{history.added_count}</td>
                        <td className="px-6 py-4 text-emerald-600 font-medium">-{history.removed_count}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <SanctionApp />
    </ErrorBoundary>
  );
}
