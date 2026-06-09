require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { parse } = require('csv-parse/sync');

const MESSAGE_TEMPLATE =
    process.env.MESSAGE_TEMPLATE ||
    "Hi {name}, I wanted to reach out and see if there's a fit — would you be open to a quick chat?";
const DELAY_MS = parseInt(process.env.DELAY_MS ?? '3000', 10);

function buildMessage(name) {
    return MESSAGE_TEMPLATE.replace(/\{name\}/g, name);
}

function formatPhone(raw) {
    const digits = raw.replace(/\D/g, '');
    return `${digits}@c.us`;
}

async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function sendToLeads(client, leads) {
    const results = [];

    for (const lead of leads) {
        const name = (lead.name || '').trim();
        const phone = (lead.phone || '').trim();

        if (!name || !phone) {
            console.warn(`Skipping row — missing name or phone: ${JSON.stringify(lead)}`);
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

    return results;
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
        console.error('No leads found in CSV.');
        process.exit(1);
    }

    const sample = leads[0];
    if (!('name' in sample) || !('phone' in sample)) {
        console.error('CSV must have "name" and "phone" column headers.');
        process.exit(1);
    }

    console.log(`Loaded ${leads.length} lead(s) from ${csvPath}`);
    console.log(`Template: "${MESSAGE_TEMPLATE}"`);
    console.log(`Delay between messages: ${DELAY_MS}ms\n`);
    console.log('Starting WhatsApp client — scan the QR code when it appears...\n');

    const client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
        },
    });

    client.on('qr', (qr) => {
        qrcode.generate(qr, { small: true });
        console.log('\nScan the QR code above with your WhatsApp app (Linked Devices).\n');
    });

    client.on('authenticated', () => console.log('Authenticated.\n'));

    client.on('auth_failure', (msg) => {
        console.error('Authentication failed:', msg);
        process.exit(1);
    });

    client.on('ready', async () => {
        console.log('WhatsApp ready. Sending messages...\n');

        const results = await sendToLeads(client, leads);

        const sent = results.filter((r) => r.status === 'sent').length;
        const failed = results.filter((r) => r.status === 'failed').length;

        console.log(`\nFinished — sent: ${sent}, failed: ${failed}`);

        await client.destroy();
    });

    await client.initialize();
}

main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
