require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { parse } = require('csv-parse/sync');

const MESSAGE_TEMPLATE =
    process.env.MESSAGE_TEMPLATE ||
    "Hi {name}, I came across your business and wanted to reach out — would you be open to a quick chat?";
const DELAY_MS = parseInt(process.env.DELAY_MS ?? '3000', 10);
const NAME_COL = process.env.NAME_COLUMN || 'name';
const PHONE_COL = process.env.PHONE_COLUMN || 'phone';
const COUNTRY_CODE = (process.env.COUNTRY_CODE || '').replace(/\D/g, '');

function buildMessage(name) {
    return MESSAGE_TEMPLATE.replace(/\{name\}/g, name);
}

function formatPhone(raw) {
    let digits = raw.replace(/\D/g, '');

    // Already has full country code (e.g. +2348... or 2348...)
    if (COUNTRY_CODE && digits.startsWith(COUNTRY_CODE) && digits.length > COUNTRY_CODE.length + 6) {
        return `${digits}@c.us`;
    }

    // Local format starting with 0 — replace leading 0 with country code
    if (COUNTRY_CODE && digits.startsWith('0')) {
        digits = COUNTRY_CODE + digits.slice(1);
    }

    return `${digits}@c.us`;
}

async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function sendToLeads(client, leads) {
    const results = [];
    let skipped = 0;

    for (const lead of leads) {
        const name = (lead[NAME_COL] || '').trim();
        const phone = (lead[PHONE_COL] || '').trim();

        if (!phone) {
            console.warn(`[skip]   ${name || '(unnamed)'} — no phone number`);
            skipped++;
            continue;
        }

        if (!name) {
            console.warn(`[skip]   ${phone} — no name`);
            skipped++;
            continue;
        }

        const chatId = formatPhone(phone);
        const message = buildMessage(name);

        try {
            await client.sendMessage(chatId, message);
            console.log(`[sent]   ${name} (${phone})`);
            results.push({ name, phone, status: 'sent' });
        } catch (err) {
            console.error(`[failed] ${name} (${phone}): ${err.message}`);
            results.push({ name, phone, status: 'failed', error: err.message });
        }

        if (DELAY_MS > 0) await sleep(DELAY_MS);
    }

    return { results, skipped };
}

async function main() {
    const csvPath = process.argv[2];

    if (!csvPath) {
        console.error('Usage: node index.js <path/to/leads.csv>');
        process.exit(1);
    }

    if (!fs.existsSync(csvPath)) {
        console.error(`CSV file not found: ${csvPath}`);
        process.exit(1);
    }

    const leads = parse(fs.readFileSync(csvPath, 'utf8'), {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    });

    if (leads.length === 0) {
        console.error('No rows found in CSV.');
        process.exit(1);
    }

    const sample = leads[0];
    if (!(NAME_COL in sample)) {
        console.error(`Column "${NAME_COL}" not found. Available columns: ${Object.keys(sample).join(', ')}`);
        console.error('Set NAME_COLUMN in .env to match your CSV header.');
        process.exit(1);
    }
    if (!(PHONE_COL in sample)) {
        console.error(`Column "${PHONE_COL}" not found. Available columns: ${Object.keys(sample).join(', ')}`);
        console.error('Set PHONE_COLUMN in .env to match your CSV header.');
        process.exit(1);
    }

    const withPhone = leads.filter((r) => (r[PHONE_COL] || '').trim());
    console.log(`Loaded ${leads.length} row(s) — ${withPhone.length} have a phone number`);
    console.log(`Template : "${MESSAGE_TEMPLATE}"`);
    console.log(`Delay    : ${DELAY_MS}ms between messages`);
    console.log(`Country  : +${COUNTRY_CODE || '(none)'}\n`);
    console.log('Starting WhatsApp — scan the QR code when it appears...\n');

    const client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
        },
    });

    client.on('qr', (qr) => {
        qrcode.generate(qr, { small: true });
        console.log('\nScan the QR code above with WhatsApp (Linked Devices > Link a Device).\n');
    });

    client.on('authenticated', () => console.log('Authenticated.\n'));

    client.on('auth_failure', (msg) => {
        console.error('Authentication failed:', msg);
        process.exit(1);
    });

    client.on('ready', async () => {
        console.log('WhatsApp ready. Sending messages...\n');

        const { results, skipped } = await sendToLeads(client, leads);

        const sent = results.filter((r) => r.status === 'sent').length;
        const failed = results.filter((r) => r.status === 'failed').length;

        console.log(`\nDone — sent: ${sent}, failed: ${failed}, skipped (no phone): ${skipped}`);

        await client.destroy();
    });

    await client.initialize();
}

main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
