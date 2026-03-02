import { NextResponse } from 'next/server';

export async function POST(request) {
    try {
        const formData = await request.formData();
        const file = formData.get('file');
        const fileType = formData.get('type'); // 'tenencia' or 'movimientos'

        if (!file) {
            return NextResponse.json({ error: 'No file provided' }, { status: 400 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());

        if (fileType === 'tenencia') {
            // Parse PDF using pdfjs-dist
            const pdfjsLib = require('pdfjs-dist/build/pdf.js');
            const data = new Uint8Array(buffer);
            const doc = await pdfjsLib.getDocument({ data }).promise;

            let fullText = '';
            for (let i = 1; i <= doc.numPages; i++) {
                const page = await doc.getPage(i);
                const content = await page.getTextContent();
                const pageText = content.items.map(item => item.str).join(' ');
                fullText += pageText + '\n';
            }

            return NextResponse.json({ text: fullText, type: 'tenencia' });
        } else if (fileType === 'movimientos') {
            // XLS files from IOL are actually HTML
            const htmlContent = buffer.toString('utf-8');
            return NextResponse.json({ html: htmlContent, type: 'movimientos' });
        }

        return NextResponse.json({ error: 'Unknown file type' }, { status: 400 });
    } catch (error) {
        console.error('Parse error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export const config = {
    api: {
        bodyParser: false,
    },
};
