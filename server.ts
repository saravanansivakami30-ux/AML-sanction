import express from 'express';
import { createServer as createViteServer } from 'vite';
import axios from 'axios';
import { parse } from 'csv-parse/sync';
import { parseStringPromise } from 'xml2js';
import * as cheerio from 'cheerio';
import path from 'path';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const firebaseConfig = require('./firebase-applet-config.json');

console.log('--- SERVER STARTING ---');
const app = express();
const PORT = 3000;

app.use(express.json());

// Resilient Firebase Admin Initialization
let db: any;

function getDb() {
  if (!db) {
    console.log('Initializing Firebase Admin...');
    try {
      if (getApps().length === 0) {
        initializeApp({
          projectId: firebaseConfig.projectId,
        });
        console.log('Firebase Admin initialized');
      }
      db = getFirestore(firebaseConfig.firestoreDatabaseId);
      console.log('Firestore instance retrieved');
    } catch (e: any) {
      console.error('Firebase initialization error:', e);
      throw e;
    }
  }
  return db;
}

export { app };

// Scrapers
class SanctionScraper {
  static async scrapeUN() {
    console.log('Scraping UN Security Council...');
    const response = await axios.get('https://scsanctions.un.org/resources/xml/en/consolidated.xml', { timeout: 60000 });
    const result = await parseStringPromise(response.data);
    
    const individuals = result.CONSOLIDATED_LIST?.INDIVIDUALS?.[0]?.INDIVIDUAL || [];
    const entities = result.CONSOLIDATED_LIST?.ENTITIES?.[0]?.ENTITY || [];
    
    const items: any[] = [];
    
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
        items.push({
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
        items.push({
          id,
          name,
          type: 'Entity',
          source: 'UN',
          url_source: 'https://www.un.org/securitycouncil/sanctions/un-sc-consolidated-list',
          profile_data: JSON.stringify(profileData)
        });
      }
    });
    
    return items;
  }

  static async scrapeUS() {
    console.log('Scraping US OFAC...');
    const response = await axios.get('https://www.treasury.gov/ofac/downloads/sdn.csv', { timeout: 60000 });
    const records = parse(response.data, {
      skip_empty_lines: true,
      relax_column_count: true
    });
    
    const items: any[] = [];
    
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
          items.push({
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
    
    return items;
  }

  static async scrapeMHA() {
    console.log('Scraping MHA Banned Organisations...');
    const response = await axios.get('https://www.mha.gov.in/en/banned-organisations', { timeout: 60000 });
    const $ = cheerio.load(response.data);
    
    const items: any[] = [];
    
    $('table').first().find('tr').each((i, el) => {
      const tds = $(el).find('td');
      if (tds.length >= 2) {
        const idNum = $(tds[0]).text().trim();
        const name = $(tds[1]).text().trim();
        
        if (name && idNum) {
          const id = `MHA-ORG-${idNum}`;
          items.push({
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
    
    return items;
  }

  static async scrapeFIUIND() {
    console.log('Scraping FIU-IND High Risk Entities (Simulated)...');
    const simulatedData = [
      { id: 'FIU-001', name: 'Simulated Shell Corp A', type: 'Entity', reason: 'High-risk jurisdiction transactions' },
      { id: 'FIU-002', name: 'Simulated Hawala Operator B', type: 'Individual', reason: 'Unregistered money service business' },
      { id: 'FIU-003', name: 'Simulated Crypto Exchange C', type: 'Entity', reason: 'Non-compliant with PMLA guidelines' }
    ];
    
    return simulatedData.map(item => ({
      id: item.id,
      name: item.name,
      type: item.type,
      source: 'FIU-IND',
      url_source: 'https://fiuindia.gov.in/',
      profile_data: JSON.stringify({
        reason: item.reason,
        status: 'High Risk / Alert'
      })
    }));
  }
}

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', environment: process.env.NODE_ENV, vercel: !!process.env.VERCEL });
});

app.get('/api/sanctions', async (req, res) => {
  try {
    const firestore = getDb();
    const { search, source, type, action, limit = 50 } = req.query;
    
    let query = firestore.collection('sanctions');
    
    if (source) {
      query = query.where('source', '==', source);
    }
    
    if (type) {
      query = query.where('type', '==', type);
    }
    
    if (action) {
      query = query.where('action', '==', action);
    }
    
    const snapshot = await query.orderBy('date_updated', 'desc').limit(Number(limit) * 2).get();
    let rows = snapshot.docs.map((doc: any) => doc.data());
    
    if (search) {
      const searchLower = String(search).toLowerCase();
      rows = rows.filter((row: any) => row.name.toLowerCase().includes(searchLower));
    }
    
    res.json(rows.slice(0, Number(limit)));
  } catch (error: any) {
    console.error('Firestore error:', error);
    res.status(500).json([]); // Return empty array to prevent frontend crash
  }
});

app.get('/api/sanctions/export', async (req, res) => {
  try {
    const firestore = getDb();
    const snapshot = await firestore.collection('sanctions').orderBy('date_updated', 'desc').get();
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
    const firestore = getDb();
    const snapshot = await firestore.collection('sync_history').orderBy('sync_date', 'desc').limit(20).get();
    const rows = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(rows);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/scrape/:source', async (req, res) => {
  try {
    const { source } = req.params;
    let data;
    switch (source.toLowerCase()) {
      case 'un': data = await SanctionScraper.scrapeUN(); break;
      case 'us': data = await SanctionScraper.scrapeUS(); break;
      case 'mha': data = await SanctionScraper.scrapeMHA(); break;
      case 'fiu': data = await SanctionScraper.scrapeFIUIND(); break;
      default: return res.status(400).json({ error: 'Invalid source' });
    }
    res.json(data);
  } catch (error: any) {
    console.error('Scrape error:', error);
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
