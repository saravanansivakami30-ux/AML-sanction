import express from 'express';
import { createServer as createViteServer } from 'vite';
import axios from 'axios';
import { parse } from 'csv-parse/sync';
import { parseStringPromise } from 'xml2js';
import * as cheerio from 'cheerio';
import path from 'path';
import * as admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import firebaseConfig from './firebase-applet-config.json';

console.log('--- SERVER STARTING ---');
const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize Firebase Admin
console.log('Initializing Firebase Admin...');
try {
  // In this environment, we should use the projectId from the config
  // and let the environment handle the credentials if possible.
  admin.initializeApp({
    projectId: firebaseConfig.projectId,
  });
  console.log('Firebase Admin initialized successfully');
} catch (e: any) {
  if (e.code === 'app/duplicate-app') {
    console.log('Firebase Admin already initialized');
  } else {
    console.error('Firebase Admin initialization failed:', e);
  }
}

const db = getFirestore(firebaseConfig.firestoreDatabaseId);
console.log('Firestore instance retrieved');

export { app };

// Scrapers
class SanctionScraper {
  static async syncUN() {
    console.log('Syncing UN Security Council...');
    try {
      const response = await axios.get('https://scsanctions.un.org/resources/xml/en/consolidated.xml', { timeout: 60000 });
      const result = await parseStringPromise(response.data);
      
      const individuals = result.CONSOLIDATED_LIST?.INDIVIDUALS?.[0]?.INDIVIDUAL || [];
      const entities = result.CONSOLIDATED_LIST?.ENTITIES?.[0]?.ENTITY || [];
      
      const currentItems = new Map<string, any>();
      
      individuals.forEach((ind: any) => {
        const id = `UN-IND-${ind.DATAID?.[0]}`;
        const firstName = ind.FIRST_NAME?.[0] || '';
        const secondName = ind.SECOND_NAME?.[0] || '';
        const thirdName = ind.THIRD_NAME?.[0] || '';
        const name = `${firstName} ${secondName} ${thirdName}`.trim();
        
        const profileData = {
          nationality: ind.NATIONALITY?.[0]?.VALUE?.[0] || '',
          designation: ind.DESIGNATION?.[0]?.VALUE?.[0] || '',
          date_of_birth: ind.INDIVIDUAL_DATE_OF_BIRTH?.[0]?.DATE?.[0] || '',
          place_of_birth: ind.INDIVIDUAL_PLACE_OF_BIRTH?.[0]?.CITY?.[0] || '',
          comments: ind.COMMENTS1?.[0] || ''
        };
        
        if (name) {
          currentItems.set(id, {
            id,
            name,
            type: 'Individual',
            source: 'UN',
            url_source: 'https://www.un.org/securitycouncil/sanctions/un-sc-consolidated-list',
            profile_data: JSON.stringify(profileData)
          });
        }
      });
      
      entities.forEach((ent: any) => {
        const id = `UN-ENT-${ent.DATAID?.[0]}`;
        const name = ent.FIRST_NAME?.[0] || '';
        
        const profileData = {
          comments: ent.COMMENTS1?.[0] || ''
        };
        
        if (name) {
          currentItems.set(id, {
            id,
            name,
            type: 'Entity',
            source: 'UN',
            url_source: 'https://www.un.org/securitycouncil/sanctions/un-sc-consolidated-list',
            profile_data: JSON.stringify(profileData)
          });
        }
      });
      
      await this.processDelta('UN', currentItems);
      return { success: true, source: 'UN' };
    } catch (error: any) {
      console.error('Error syncing UN:', error.message);
      return { success: false, source: 'UN', error: error.message };
    }
  }

  static async syncUS() {
    console.log('Syncing US OFAC...');
    try {
      const response = await axios.get('https://www.treasury.gov/ofac/downloads/sdn.csv', { timeout: 60000 });
      const records = parse(response.data, {
        skip_empty_lines: true,
        relax_column_count: true
      });
      
      const currentItems = new Map<string, any>();
      
      records.forEach((record: any[]) => {
        if (record.length >= 12) {
          const id = `US-${record[0]}`;
          const name = record[1];
          const typeRaw = record[2];
          
          let type = 'Entity';
          if (typeRaw.includes('individual')) type = 'Individual';
          else if (typeRaw.includes('vessel')) type = 'Vessel';
          
          const profileData = {
            program: record[3] || '',
            title: record[4] || '',
            vessel_type: record[6] || '',
            vessel_flag: record[9] || '',
            vessel_owner: record[10] || '',
            remarks: record[11] || ''
          };
          
          if (name && name !== '-0-') {
            currentItems.set(id, {
              id,
              name,
              type,
              source: 'US',
              url_source: 'https://ofac.treasury.gov/',
              profile_data: JSON.stringify(profileData)
            });
          }
        }
      });
      
      await this.processDelta('US', currentItems);
      return { success: true, source: 'US' };
    } catch (error: any) {
      console.error('Error syncing US OFAC:', error.message);
      return { success: false, source: 'US', error: error.message };
    }
  }

  static async syncMHA() {
    console.log('Syncing MHA Banned Organisations...');
    try {
      const response = await axios.get('https://www.mha.gov.in/en/banned-organisations', { timeout: 60000 });
      const $ = cheerio.load(response.data);
      
      const currentItems = new Map<string, any>();
      
      $('table').first().find('tr').each((i, el) => {
        const tds = $(el).find('td');
        if (tds.length >= 2) {
          const idNum = $(tds[0]).text().trim();
          const name = $(tds[1]).text().trim();
          
          if (name && idNum) {
            const id = `MHA-ORG-${idNum}`;
            currentItems.set(id, {
              id,
              name,
              type: 'Entity',
              source: 'MHA India',
              url_source: 'https://www.mha.gov.in/en/banned-organisations',
              profile_data: JSON.stringify({
                remarks: 'Banned under Unlawful Activities (Prevention) Act, 1967'
              })
            });
          }
        }
      });
      
      await this.processDelta('MHA India', currentItems);
      return { success: true, source: 'MHA India' };
    } catch (error: any) {
      console.error('Error syncing MHA India:', error.message);
      return { success: false, source: 'MHA India', error: error.message };
    }
  }

  static async syncFIUIND() {
    console.log('Syncing FIU-IND High Risk Entities (Simulated)...');
    try {
      const simulatedData = [
        { id: 'FIU-001', name: 'Simulated Shell Corp A', type: 'Entity', reason: 'High-risk jurisdiction transactions' },
        { id: 'FIU-002', name: 'Simulated Hawala Operator B', type: 'Individual', reason: 'Unregistered money service business' },
        { id: 'FIU-003', name: 'Simulated Crypto Exchange C', type: 'Entity', reason: 'Non-compliant with PMLA guidelines' }
      ];
      
      const currentItems = new Map<string, any>();
      
      simulatedData.forEach(item => {
        currentItems.set(item.id, {
          id: item.id,
          name: item.name,
          type: item.type,
          source: 'FIU-IND',
          url_source: 'https://fiuindia.gov.in/',
          profile_data: JSON.stringify({
            reason: item.reason,
            status: 'High Risk / Alert'
          })
        });
      });
      
      await this.processDelta('FIU-IND', currentItems);
      return { success: true, source: 'FIU-IND' };
    } catch (error: any) {
      console.error('Error syncing FIU-IND:', error.message);
      return { success: false, source: 'FIU-IND', error: error.message };
    }
  }

  static async processDelta(source: string, currentItems: Map<string, any>) {
    const today = admin.firestore.Timestamp.now();
    
    console.log(`Processing delta for ${source}...`);
    
    // Get existing items for this source from Firestore
    const sanctionsRef = db.collection('sanctions');
    const snapshot = await sanctionsRef.where('source', '==', source).get();
    
    const existingMap = new Map<string, string>();
    snapshot.forEach(doc => {
      const data = doc.data();
      existingMap.set(data.id, data.action);
    });
    
    let addedCount = 0;
    let removedCount = 0;
    
    const batch = db.batch();
    
    // Check for new or re-listed items
    for (const [id, item] of currentItems.entries()) {
      const docRef = sanctionsRef.doc(id.replace(/\//g, '_')); // Ensure safe ID
      
      if (!existingMap.has(id)) {
        // New item
        batch.set(docRef, {
          ...item,
          date_updated: today,
          action: 'Listed'
        });
        addedCount++;
      } else if (existingMap.get(id) === 'Delisted') {
        // Re-listed item
        batch.update(docRef, {
          action: 'Listed',
          date_updated: today,
          profile_data: item.profile_data || null
        });
        addedCount++;
      } else {
        // Already listed, update profile data
        batch.update(docRef, {
          profile_data: item.profile_data || null
        });
      }
    }
    
    // Check for delisted items
    for (const [id, action] of existingMap.entries()) {
      if (!currentItems.has(id) && action !== 'Delisted') {
        const docRef = sanctionsRef.doc(id.replace(/\//g, '_'));
        batch.update(docRef, {
          action: 'Delisted',
          date_updated: today
        });
        removedCount++;
      }
    }
    
    // Log history
    const historyRef = db.collection('sync_history').doc();
    batch.set(historyRef, {
      source,
      sync_date: today,
      added_count: addedCount,
      removed_count: removedCount
    });
    
    await batch.commit();
    console.log(`${source} sync complete. Added: ${addedCount}, Removed: ${removedCount}`);
  }
}

// API Routes
app.get('/api/sanctions', async (req, res) => {
  try {
    const { search, source, type, action, limit = 50 } = req.query;
    
    let query: admin.firestore.Query = db.collection('sanctions');
    
    if (source) {
      query = query.where('source', '==', source);
    }
    
    if (type) {
      query = query.where('type', '==', type);
    }
    
    if (action) {
      query = query.where('action', '==', action);
    }
    
    // Note: Firestore doesn't support partial string matching (LIKE) natively without external search engines.
    // We'll fetch and filter in memory for small datasets, or use a simpler prefix match if possible.
    // For this demo, we'll fetch more and filter in memory if search is present.
    
    const snapshot = await query.orderBy('date_updated', 'desc').limit(Number(limit) * 2).get();
    let rows = snapshot.docs.map(doc => doc.data());
    
    if (search) {
      const searchLower = String(search).toLowerCase();
      rows = rows.filter(row => row.name.toLowerCase().includes(searchLower));
    }
    
    res.json(rows.slice(0, Number(limit)));
  } catch (error: any) {
    console.error('Firestore error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sanctions/export', async (req, res) => {
  try {
    const snapshot = await db.collection('sanctions').orderBy('date_updated', 'desc').get();
    const rows = snapshot.docs.map(doc => doc.data());
    
    if (rows.length === 0) {
      return res.status(404).send('No data available');
    }
    
    const headers = ['id', 'name', 'type', 'source', 'date_updated', 'action', 'url_source', 'profile_data'].join(',');
    const csvRows = rows.map(row => {
      return [
        row.id, row.name, row.type, row.source, row.date_updated, row.action, row.url_source, row.profile_data
      ].map(value => {
        const str = String(value !== null && value !== undefined ? value : '');
        return `"${str.replace(/"/g, '""')}"`;
      }).join(',');
    });
    
    const csv = [headers, ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="sanctions_data.csv"');
    res.send(csv);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sync-history', async (req, res) => {
  try {
    const snapshot = await db.collection('sync_history').orderBy('sync_date', 'desc').limit(20).get();
    const rows = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(rows);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    const results = await Promise.all([
      SanctionScraper.syncUN(),
      SanctionScraper.syncUS(),
      SanctionScraper.syncMHA(),
      SanctionScraper.syncFIUIND()
    ]);
    res.json({ success: true, results });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Vite middleware for development
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  startServer();
}

export default app;
