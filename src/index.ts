import Koa from 'koa';
import Router from 'koa-router';
import fs, { readFileSync } from "fs"
import 'dotenv/config'
import { TextDecoder } from 'util';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { transpile } from "./transpile_ecm";
import { Declaration as CSSDeclaration } from "css";
import path from "path";
import { decodeEUCJP } from './euc_jp';
import { loadDRCS, toTTF } from './drcs';

const baseDir = process.env.BASE_DIR;
if (!baseDir) {
    console.error("BASE_DIR");
    process.exit(1);
}

type Component = {
    [key: string]: Module
};

type Module = {
    [key: string]: File
};

type File = {
    [key: string]: {}
};

const components: { [key: string]: Component } = {};

for (const componentDirent of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!componentDirent.isDirectory() || componentDirent.name.length !== 2) {
        continue;
    }
    const component: Component = {};
    components[componentDirent.name.toLowerCase()] = component;
    for (const moduleDirent of fs.readdirSync(path.join(baseDir, componentDirent.name), { withFileTypes: true })) {
        if (!moduleDirent.isDirectory() || moduleDirent.name.length !== 4) {
            continue;
        }
        const module: Module = {};
        component[moduleDirent.name.toLowerCase()] = module;
        for (const fileDirent of fs.readdirSync(path.join(baseDir, componentDirent.name, moduleDirent.name), { withFileTypes: true })) {
            if (!fileDirent.isFile()) {
                continue;
            }
            const file: File = {};
            module[fileDirent.name.toLowerCase()] = file;
        }
    }
}

const app = new Koa();
const router = new Router();

function findXmlNode(xml: any[], nodeName: string): any {
    const result = [];
    for (const i of xml) {
        for (const k in i) {
            if (k === ":@") {
                continue;
            }
            if (k == nodeName) {
                result.push(i);
                break;
            }
        }
    }
    return result;
}

function renameXmlNode(node: any, name: string) {
    for (const k in node) {
        if (k === ":@") {
            continue;
        }
        node[name] = node[k];
        delete node[k];
    }
}

function getXmlNodeName(node: any): string | null {
    for (const k in node) {
        if (k === ":@") {
            continue;
        }
        return k;
    }
    return null;
}

function getXmlChildren(node: any): any[] {
    for (const k in node) {
        if (k == "#text") {
            return [];
        }
        if (k === ":@") {
            continue;
        }
        return node[k];
    }
    return [];
}

function visitXmlNodes(node: any, callback: (node: any) => void) {
    callback(node);
    for (const child of getXmlChildren(node)) {
        visitXmlNodes(child, callback);
    }
}


function readFileAsync2(path: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
        fs.readFile(path, null, (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    })
}

function decodeText(enc: string, data: Buffer | Uint8Array) {
    if (enc.match(/euc[-_]?jp/i)) {
        return decodeEUCJP(data);
    } else {
        return new TextDecoder(enc).decode(data);
    }
}

function readFileAsync(path: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        fs.readFile(path, null, (err, data) => {
            if (err) {
                reject(err);
            } else {
                const opts = {
                    ignoreAttributes: false,
                    attributeNamePrefix: "@_",
                    preserveOrder: true,
                    cdataPropName: "__cdata",
                };
                const parser = new XMLParser(opts);
                let parsed = parser.parse(data);
                parsed = parser.parse(decodeText(parsed[0][":@"]["@_encoding"], data));
                parsed[0][":@"]["@_encoding"] = "UTF-8";
                const builder = new XMLBuilder(opts);
                const bmlRoot = findXmlNode(parsed, "bml")[0];
                renameXmlNode(bmlRoot, "html");
                if (!bmlRoot[":@"]) {
                    bmlRoot[":@"] = {};
                }
                bmlRoot[":@"]["@_xmlns"] = "http://www.w3.org/1999/xhtml";
                const htmlChildren = bmlRoot["html"];
                const headChildren: any[] = findXmlNode(htmlChildren, "head")[0]["head"];
                const scripts: any[] = [];
                visitXmlNodes(bmlRoot, (node) => {
                    if (getXmlNodeName(node) == "script") {
                        scripts.push({ ...node });
                        renameXmlNode(node, "arib-script");
                    }
                    if (getXmlNodeName(node) == "style") {
                        renameXmlNode(node, "arib-style");
                    }
                    if (getXmlNodeName(node) == "link") {
                        if (!node[":@"]["@_rel"]) {
                            node[":@"]["@_rel"] = "stylesheet";
                        }
                    }
                    /*
                    // keyイベントは独自なのでエミュレートした方がよさそう
                    const attrs = node[":@"] as any;
                    if (attrs && Object.keys(attrs).some(x => x.toLowerCase().startsWith("@_onkey"))) {
                        attrs["@_tabindex"] = "-1";
                    } */
                });
                const bodyChildren = findXmlNode(htmlChildren, "body")[0]["body"];
                bodyChildren.push({
                    "script": [],
                    ":@": {
                        "@_src": "/arib.js"
                    }
                });
                for (const s of scripts) {
                    const __cdata = s["script"][0] && s["script"][0]["__cdata"];
                    if (__cdata) {
                        const code = __cdata[0]["#text"];
                        __cdata[0]["#text"] = transpile(code);
                    }
                    bodyChildren.push(s);
                }
                headChildren.splice(0, 0, {
                    "link": [],
                    ":@": {
                        "@_href": "/default.css",
                        "@_rel": "stylesheet"
                    }
                }, {
                    "script": [
                        {
                            "#text": JSON.stringify(components)
                        }
                    ], ":@": {
                        "@_type": "application/json",
                        "@_id": "bml-server-data",
                    }
                });
                //console.log(JSON.stringify(parsed, null, 4));
                resolve(builder.build(parsed));
            }
        });
    });
}

import { defaultCLUT } from './default_clut';
function readCLUT(clut: Buffer): number[][] {
    let table = defaultCLUT.slice();
    const prevLength = table.length;
    table.length = 256;
    table = table.fill([0, 0, 0, 255], prevLength, 256);
    // STD-B24 第二分冊(2/2) A3 5.1.7 表5-8参照
    // clut_typeは0(YCbCr)のみ運用される
    const clutType = clut[0] & 0x80;
    // depthは8ビット(1)のみが運用される
    const depth = (clut[0] & 0x60) >> 5;
    // region_flagは0のみが運用される
    const regionFlag = clut[0] & 0x10;
    // start_end_flagは1のみが運用される
    const startEndFlag = clut[0] & 0x8;
    let index = 1;
    if (regionFlag) {
        index += 2;
        index += 2;
        index += 2;
        index += 2;
        // 運用されない
        console.error("region is not implemented");
    }
    let startIndex: number;
    let endIndex: number;
    if (startEndFlag) {
        if (depth == 0) {
            startIndex = clut[index] >> 4;
            endIndex = clut[index] & 15;
            index++;
        } else if (depth == 1) {
            // start_indexは128のみが運用される
            startIndex = clut[index++];
            // end_ndexは223のみが運用される
            endIndex = clut[index++];
        } else if (depth == 2) {
            startIndex = clut[index++];
            startIndex = (startIndex << 8) | clut[index++];
            endIndex = clut[index++];
            endIndex = (endIndex << 8) | clut[index++];
        } else {
            throw new Error("unexpected");
        }
        for (let i = startIndex; i <= endIndex; i++) {
            let R: number;
            let G: number;
            let B: number;
            if (clutType == 0) {
                const Y = clut[index++];
                const Cb = clut[index++];
                const Cr = clut[index++];
                R = Math.max(0, Math.min(255, Math.floor(1.164 * (Y - 16) + 1.793 * (Cr - 128))));
                G = Math.max(0, Math.min(255, Math.floor(1.164 * (Y - 16) - 0.213 * (Cb - 128) - 0.533 * (Cr - 128))));
                B = Math.max(0, Math.min(255, Math.floor(1.164 * (Y - 16) + 2.112 * (Cb - 128))));
            } else {
                R = clut[index++];
                G = clut[index++];
                B = clut[index++];
            }
            // Aは0以外が運用される
            const A = clut[index++];
            table[i] = [R, G, B, A];
        }
    } else {
        // 運用されない
        throw new Error("not implemented");
    }
    return table;
}

import CRC32 from "crc-32";
import { transpileCSS } from './transpile_css';

function preparePLTE(clut: number[][]): Buffer {
    const plte = Buffer.alloc(4 /* PLTE */ + 4 /* size */ + clut.length * 3 + 4 /* CRC32 */);
    let off = 0;
    off = plte.writeUInt32BE(clut.length * 3, off);
    off += plte.write("PLTE", off);
    for (const entry of clut) {
        off = plte.writeUInt8(entry[0], off);
        off = plte.writeUInt8(entry[1], off);
        off = plte.writeUInt8(entry[2], off);
    }
    plte.writeInt32BE(CRC32.buf(plte.slice(4, off), 0), off);
    return plte;
}

function prepareTRNS(clut: number[][]): Buffer {
    const trns = Buffer.alloc(4 /* PLTE */ + 4 /* size */ + clut.length + 4 /* CRC32 */);
    let off = 0;
    off = trns.writeUInt32BE(clut.length, off);
    off += trns.write("tRNS", off);
    for (const entry of clut) {
        off = trns.writeUInt8(entry[3], off);
    }
    trns.writeInt32BE(CRC32.buf(trns.slice(4, off), 0), off);
    return trns;
}

function clutToDecls(table: number[][]): CSSDeclaration[] {
    const ret = [];
    let i = 0;
    for (const t of table) {
        const decl: CSSDeclaration = {
            type: "declaration",
            property: "--clut-color-" + i,
            value: `rgba(${t[0]},${t[1]},${t[2]},${t[3] / 255})`,
        };
        ret.push(decl);
        i++;
    }
    return ret;
}

function isPLTEMissing(png: Buffer): boolean {
    let off = 8;
    // IHDR
    const type = png[off + 0x11];
    // palette
    if (type !== 3) {
        return false;
    }
    off += png.readUInt32BE(off) + 4 * 3;
    while (true) {
        let chunkLength = png.readUInt32BE(off);
        let chunkType = png.toString("ascii", off + 4, off + 8);
        if (chunkType === "IDAT" || chunkType === "IEND") {
            return true;
        }
        if (chunkType === "PLTE") {
            return false;
        }
        off += chunkLength + 4 * 3;
    }
}

async function aribPNGToPNG(png: Buffer, clut: string): Promise<Buffer> {
    if (!isPLTEMissing(png)) {
        return png;
    }
    const table = readCLUT(await readFileAsync2(`${process.env.BASE_DIR}/${clut}`));
    const plte = preparePLTE(table);
    const trns = prepareTRNS(table);
    const output = Buffer.alloc(png.length + plte.length + trns.length);
    let off = 0;
    off += png.copy(output, off, 0, 33);
    off += plte.copy(output, off);
    off += trns.copy(output, off);
    off += png.copy(output, off, 33);
    return output;
}

router.get('/:component/:module/:filename', proc);
router.get('/:component/:moduleUnused/~/:module/:filename', async ctx => {
    const component = (ctx.params.component as string).toLowerCase();
    const module = (ctx.params.module as string).toLowerCase();
    const filename = (ctx.params.filename as string).toLowerCase();
    ctx.redirect(`/${component}/${module}/${filename}`);
});
async function proc(ctx: Koa.ParameterizedContext<any, Router.IRouterParamContext<any, {}>, any>) {
    const component = (ctx.params.component as string).toLowerCase();
    const module = (ctx.params.module as string).toLowerCase();
    const filename = (ctx.params.filename as string).toLowerCase();
    if (ctx.headers["sec-fetch-dest"] === "script" || filename.endsWith(".ecm")) {
        const b = await readFileAsync2(`${process.env.BASE_DIR}/${component}/${module}/${filename}`);
        const file = new TextDecoder("euc-jp").decode(b);
        ctx.body = transpile(file);
        ctx.set("Content-Type", "text/X-arib-ecmascript");
    } else if (ctx.headers["sec-fetch-dest"] === "style" || filename.endsWith(".css")) {
        const b = await readFileAsync2(`${process.env.BASE_DIR}/${component}/${module}/${filename}`);
        const file = new TextDecoder("euc-jp").decode(b);
        ctx.body = transpileCSS(file, {
            inline: false, href: ctx.href, clutReader(cssValue: string) {
                return clutToDecls(readCLUT(readFileSync(`${process.env.BASE_DIR}/${cssValue}`)));
            }
        });
        ctx.set("Content-Type", "text/css");
    } else if (filename.endsWith(".bml")) {
        const file = await readFileAsync(`${process.env.BASE_DIR}/${component}/${module}/${filename}`);
        ctx.body = file;
        ctx.set('Content-Type', 'application/xhtml+xml')
    } else {
        if (typeof ctx.query.clut === "string") {
            const clut = ctx.query.clut;
            const png = await readFileAsync2(`${process.env.BASE_DIR}/${component}/${module}/${filename}`);
            ctx.body = await aribPNGToPNG(png, clut);
            ctx.set("Content-Type", "image/png");
            return;
        }
        if (typeof ctx.query.css === "string") {
            const clut = await readFileAsync2(`${process.env.BASE_DIR}/${component}/${module}/${filename}`);
            const table = readCLUT(clut);
            ctx.body = clutToDecls(table);
        } else if (typeof ctx.query.base64 === "string") {
            ctx.body = (await readFileAsync2(`${process.env.BASE_DIR}/${component}/${module}/${filename}`)).toString('base64');
        } else if (typeof ctx.query.ttf === "string") {
            const drcs = await readFileAsync2(`${process.env.BASE_DIR}/${component}/${module}/${filename}`);
            ctx.body = toTTF(loadDRCS(drcs));
        } else {
            const s = fs.createReadStream(`${process.env.BASE_DIR}/${component}/${module}/${filename}`);
            s.on("error", () => {
                // chrome対策でダミー画像を用意する (text/html返すとiframeになる上に画像が表示できなくなる)
                ctx.set("Content-Type", "image/png");
                const dummyPng = [
                    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x18, 0x57, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01, 0x5C, 0xCD, 0xFF, 0x69, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
                ];
                ctx.set("Content-Length", dummyPng.length.toString());
                ctx.res.write(Buffer.from(dummyPng));
                ctx.res.end();
            });
            ctx.body = s;
        }
        if (filename.endsWith(".png")) {
            ctx.set("Content-Type", "image/png");
        } else if (filename.endsWith(".jpg")) {
            ctx.set("Content-Type", "image/jpeg");
        }
    }
}

router.get('/arib.js', async ctx => {
    ctx.body = fs.createReadStream("dist/arib.js");
    ctx.set('Content-Type', 'text/javascript')
});

router.get('/arib.js.map', async ctx => {
    ctx.body = fs.createReadStream("dist/arib.js.map");
    ctx.set('Content-Type', 'application/json')
});

router.get('/default.css', async ctx => {
    ctx.body = fs.createReadStream("web/default.css");
    ctx.set('Content-Type', 'text/css')
});

router.get("/rounded-mplus-1m-arib.ttf", async ctx => {
    ctx.body = fs.createReadStream("dist/rounded-mplus-1m-arib.ttf");
});

// モトヤマルベリ
router.get("/KosugiMaru-Regular.ttf", async ctx => {
    ctx.body = fs.createReadStream("dist/KosugiMaru-Regular.ttf");
});
// モトヤシーダ
router.get("/Kosugi-Regular.ttf", async ctx => {
    ctx.body = fs.createReadStream("dist/Kosugi-Regular.ttf");
});
router.get('/api/sleep', async ctx => {
    let ms = Number(ctx.query.ms ?? "0");
    await new Promise<void>((resolve, reject) => {
        setTimeout(() => {
            resolve()
        }, ms);
    });
    ctx.body = "OK";
});
console.log("OK");
app
    .use(router.routes())
    .use(router.allowedMethods());

app.listen(23234);
