const fs = require("fs");
const JSZip = require("jszip");
const cheerio = require("cheerio");
const EventEmitter = require("events");
const path = require("path");
const mimetype = require('mimetype');
const Entities = require('html-entities').AllHtmlEntities;

class EpubProcesser extends EventEmitter {
	constructor(html, assets, size) {
		super();

		if (!html) {
			throw "Must pass a HTML Buffer to EpubProcesser";
		}
		this.assets = assets;
		// const entities = new Entities();
		// this.html = entities.decode(html);
		this.html = html;
		this.$ = cheerio.load(html, {
			xmlMode: true,
			decodeEntities: false
		});
		this.size = size;
		this.zip = this.createZip();
		this.metadata = {};
		this.stylesheet = "styles/main.css";

		this.assemble(this.$);

		return this.output();
	}

	assemble($) {
		this.addContainer();

		// Get Metadata
		let title = $("title").text();
		let metadata = {
			title: title
		};
		let metaElements = $("meta");
		metaElements.each(function (i, elem) {
			let name = $(this).attr("name");
			let content = $(this).attr("content");
			if (name && content) {
				metadata[name] = content;
			}
		});
		this.metadata = metadata;

		this.addAssets(this.assets);

		// Get Image Assets
		let images = [];
		let imgElements = $("img");
		imgElements.each(function (i, elem) {
			let src = $(this).attr("src");

			try {
				let uri = new URL(src)
				if (uri.protocol === "data:") {
					return;
				}
			} catch (error) {
				// no need to handle
			}

			if (src) {
				images.push(src);
			}

			let filename = path.basename(src);
			$(this).attr("src", `../assets/${filename}`);
		});

		// Links
		let links = [];
		let linksElements = $("a");
		linksElements.each(function (i, elem) {
			let href = $(this).attr("href");

			if (href && href[0] === "#") {
				links.push(href);

				let target = $(href);
				let page = target.closest(".pagedjs_page")
				let pageNumber = page.attr("data-page-number");
				$(this).attr("href", `section_${pageNumber}.xhtml#${href}`);
			}
		});


		// Parse HTML into pages
		let pages = [];
		let pageElements = $(".pagedjs_pages .pagedjs_page");
		pageElements.each(function (i, elem) {
			let pg = $.html(elem);
			pages.push(pg);
		});
		this.pages = pages;

		this.addContent(pages);

		// Get CSS
		let styles = [];
		let styleElements = $("style");
		styleElements.each(function (i, elem) {
			styles.push($(this).html());
		});

		this.addStyles(styles);

		this.manifest = this.createManifestItems();
		this.spine = this.createSpineItems();
		this.addToc();
		this.addOPF();
	}

	createZip() {
		let zip = new JSZip();
		zip.file("mimetype", "application/epub+zip", {
			compression: "store"
		});
		return zip;
	}

	addContainer(path="OEBPS/content.opf") {
		// Create the base of the zip
		const containerXML = `<?xml version="1.0" encoding="UTF-8"?>
		<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
			<rootfiles>
				<rootfile full-path="${path}" media-type="application/oebps-package+xml"/>
		</rootfiles>
		</container>`;
		let metaInf = this.zip.folder("META-INF");
		metaInf.file("container.xml", containerXML);
	}

	addStyles(styles) {
		let stylesheet = this.zip.file("OEBPS/" + this.stylesheet, styles.join("\n"), { createFolders: true });
		return stylesheet;
	}
	
	addAssets(assets) {
		let assetsFolder = this.zip.folder("OEBPS/assets");
		for (const asset of assets) {
			let uri = new URL(asset.url)
			if (uri.protocol === "data:") {
				continue;
			}
			assetsFolder.file(asset.filename, asset.buffer, { 
				binary: true,
				base64: false 
			});
		}
		return assetsFolder;
	}

	createPage(content, index) {
		const pageTemplate = `<?xml version="1.0" encoding="UTF-8"?>
			<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
			<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=${this.size.width}, height=${this.size.height}" />

					<title>${this.metadata.title}</title>
					<link href="../${this.stylesheet}" type="text/css" rel="stylesheet" />
				</head>
				<body>
					<div style="counter-reset: page ${index}">
						${content}
					</div>
				</body>
			</html>
			`;
		return pageTemplate;
	}

	addContent(pages) {
		let contentFolder = this.zip.folder("OEBPS/content");
		let counter = 1;
		for (const page of pages) {
			let html = this.createPage(page, counter);
			contentFolder.file(`section_${counter}.xhtml`, html);
			counter++;
		}
		
		return contentFolder;
	}

	createManifestItems() {
		let manifest = "";
		for (let index = 1; index <= this.pages.length; index++) {
			manifest += `<item href="content/section_${index}.xhtml" id="section_${index}" media-type="application/xhtml+xml" />\n`;
		}

		for (let index = 1; index <= this.assets.length; index++) {
			let uri = new URL(this.assets[index-1].url);
			let filename = this.assets[index - 1].filename;
			let mime = mimetype.lookup(filename);
			if (uri.protocol !== "data:") {
				manifest += `<item href="assets/${filename}" id="asset_${index}" media-type="${mime}" />\n`;
			}
		}
		return manifest;
	}

	createSpineItems() {
		let spine = "";
		for (let index = 1; index <= this.pages.length; index++) {
			spine += `<itemref idref="section_${index}" />\n`;
		}
		return spine;
	}

	createOPF(ident = "12345") {
		const opf = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
			<package xmlns="http://www.idpf.org/2007/opf" prefix="rendition: http://www.idpf.org/vocab/rendition/# ibooks: http://vocabulary.itunes.apple.com/rdf/ibooks/vocabulary-extensions-1.0/" unique-identifier="ident" version="3.0" xml:lang="${this.metadata.lang || "en"}">
				<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
					<dc:identifier id="ident">${ident}</dc:identifier>
					<dc:title>${this.metadata.title}</dc:title>
					<dc:creator>${this.metadata.author}</dc:creator>
					<dc:publisher>${this.metadata.creator}</dc:publisher>
					<meta property="dcterms:modified">${this.metadata.modified}</meta>
					<meta property="ibooks:version">3.0</meta>
					<meta property="rendition:layout">pre-paginated</meta>
					<meta property="rendition:spread">auto</meta>
					<meta property="rendition:orientation">auto</meta>
					<meta property="ibooks:specified-fonts">true</meta>
					<!-- <meta name="Cover" content="cover-image" /> -->
				</metadata>

				<manifest>
					${this.manifest}
					<item href="${this.stylesheet}" id="css" media-type="text/css" />
					<!-- <item href="Content/Cover.xhtml" id="Cover" media-type="application/xhtml+xml" /> -->
					<!-- <item href="assets/cover.jpg" id="cover-image" media-type="image/jpeg" properties="cover-image"/> -->
					<item href="content/nav.xhtml" id="nav" media-type="application/xhtml+xml" properties="nav" />
				</manifest>

				<spine>
					${this.spine}
				</spine>

			</package>`;

		return opf;
	}

	addOPF(ident) {
		let opf = this.createOPF(ident);
		let opfFile = this.zip.file("OEBPS/content.opf", opf, { createFolders: true });
		return opfFile;
	}

	createTocItems() {
		let toc = "";
		for (let index = 1; index <= this.pages.length; index++) {
			toc += `<li><a href="section_${index}.xhtml">Page ${index}</a></li>\n`;
		}
		return toc;
	}

	createPageList() {
		let toc = "";
		for (let index = 1; index <= this.pages.length; index++) {
			toc += `<li><a href="section_${index}.xhtml">${index}</a></li>\n`;
		}
		return toc;
	}

	createToc() {
		let sections = this.createTocItems();
		let pagelist = this.createPageList();
		let tocHtml = `<?xml version="1.0" encoding="UTF-8"?>
			<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="fr" xml:lang="fr">
			<head>
				<title>${this.metadata.title}</title>
				<meta charset="utf-8" />
			</head>
			<body>
				<section class="frontmatter TableOfContents" epub:type="frontmatter toc">
					<header>
						<h1>Table of Contents</h1>
					</header>
					<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc" id="toc">
						<ol>
							${sections}
						</ol>
					</nav>
					<nav epub:type="page-list">
						<ol>
							${pagelist}
						</ol>
					</nav>
				</section>
			</body>
			</html>`;

		return tocHtml;
	}

	addToc() {
		let tocHTML = this.createToc();
		let tocFile = this.zip.file("OEBPS/content/nav.xhtml", tocHTML, { createFolders: true });
		return tocFile;
	}

	output() {
		return this.zip.generateAsync({
			type: "nodebuffer",
			streamFiles: true,
			mimeType: "application/epub+zip",
			compression: "DEFLATE"
		});
	}

}

module.exports = EpubProcesser;


