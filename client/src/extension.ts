/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as glob from 'glob';
import { LibraryView, Library } from './libraryView';

import {
	LanguageClient,
	LanguageClientOptions,
	NotificationType,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';
import { text } from 'stream/consumers';

let client: LanguageClient; 
let libraryView: LibraryView;

// Path to the libraries.json file
const librariesFilePath = path.join(__dirname, '..', 'libraries.json');

export function activate(context: vscode.ExtensionContext) {
	
	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		path.join('parasail-ls', 'out', 'server.js')

	);

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
		}
	};

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [{ scheme: 'file', language: 'parasail' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc')
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'parasailServer',
		'ParaSail Server',
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start();

	// note: these features may need to be adjusted based on the lsp implementation
	// a lot of the work is done on the lsp's end

	// PLUGIN LIBRARY FEATURE : uc-plugin-files
	// Register the library view
	libraryView = new LibraryView(librariesFilePath);
	vscode.window.registerTreeDataProvider('libraryView', libraryView);

    // Register command to add a library
    const addLibraryCommand = vscode.commands.registerCommand('parasail.addLibrary', async () => {
        const libraryPath = await vscode.window.showInputBox({
            prompt: 'Enter the library path',
            placeHolder: '/path/to/library',
        });

		// if no path entered, return
		if (!libraryPath) {
			vscode.window.showErrorMessage('No path entered.');
			return;
		}

		// check if the library path is already added
		if ((await libraryView.getChildren()).find(lib => lib.path === libraryPath)) {
			vscode.window.showErrorMessage(`Library path ${libraryPath} already exists.`);
			return;
		}

		// if path does not exist, show error message
		if (!fs.existsSync(libraryPath)) {
			vscode.window.showErrorMessage(`The path ${libraryPath} does not exist.`);
			return;
		}

		// get the library name
		const libraryName = path.basename(libraryPath);
		let fileList: string[] = [];

		if (fs.statSync(libraryPath).isFile()) {
			// if the path is a file
			fileList.push(libraryPath);
		}
		else {
			// if the path is a directory
			const pslList = path.join(libraryPath, 'psl_list.json');

			// check if psl_list.json exists
			// if it does get files in correct order
			if (fs.existsSync(pslList)) {
				try {
					const psl = JSON.parse(fs.readFileSync(pslList, 'utf-8'));
					if (Array.isArray(psl.files)) {
						fileList = psl.files.map((file: string) => path.join(libraryPath, file));
					}
				} catch (error) {
					console.error(`Error reading psl_list.json: ${error.message}`);
					vscode.window.showErrorMessage(`Error reading psl_list.json: ${error.message}`);
					return;
				}
			}
			else {
				// if psl_list.json does not exist, get files alphabetically
				fileList = glob.sync('**/*.psl', { cwd: libraryPath }).map(f => path.join(libraryPath, f));
			}
		}

		if (fileList.length === 0) {
			vscode.window.showErrorMessage(`No .psl files found in ${libraryPath}`);
			return;
		}

		// add library to the tree view
		libraryView.addLibraryPath({ name: libraryName, path: libraryPath });

		// send notification to lsp about added library
		client.sendNotification('parasail/addLibrary', 
			{ 
				name: libraryName, 
				path: libraryPath, 
				files: fileList 
			});

		// show success message
		vscode.window.showInformationMessage(`Library '${libraryName}' added.`);
    });

    // Register command to remove a library
    const removeLibraryCommand = vscode.commands.registerCommand(
		'parasail.removeLibrary',
		async (library: Library) => {
			if (library) {
				// confirm the user wants to remove the library
				const confirm = await vscode.window.showWarningMessage(
					`Are you sure you want to remove '${library.name}'?`,
					{ modal: true },
					'Yes',
					'No'
				);
				if (confirm !== 'Yes') return;
				
				// if library selected from the tree view
				libraryView.removeLibraryPath(library);
			
				// send notification to lsp about removed library
				client.sendNotification('parasail/removeLibrary', {name: library.name, path: library.path});
			
				// show success message
				vscode.window.showInformationMessage(`Library '${library.name}' removed.`);
			} else {
				// if no library selected, ask the user to enter a path
				const libraryPath = await vscode.window.showInputBox({
					prompt: 'Enter the path of the library to remove',
					placeHolder: '/path/to/library',
				});
				if (libraryPath) {

					const matchedLibrary = (await libraryView
						.getChildren())
						.find(lib => lib.path === libraryPath);
					if (matchedLibrary) {
						// confirm the user wants to remove the library
						const confirm = await vscode.window.showWarningMessage(
							`Are you sure you want to remove '${matchedLibrary.name}'?`,
							{ modal: true },
							'Yes',
							'No'
						);
						if (confirm !== 'Yes') return;

						// send notification to lsp about removed library
						client.sendNotification('parasail/removeLibrary', {name: matchedLibrary.name, path: matchedLibrary.path});

						// remove library from the tree view
						libraryView.removeLibraryPath(matchedLibrary);
						vscode.window.showInformationMessage(`Library '${matchedLibrary.name}' removed.`);
					} else {
						vscode.window.showErrorMessage(`No library found with the path: ${libraryPath}`);
					}
		}
		}
	});
	// on LSP side, we will create new NotificationType for addLibrary and 
	// removeLibrary and handle them in the server with connection.onNotification
	//

	// add the commands to the context
	context.subscriptions.push(addLibraryCommand, removeLibraryCommand);
	
}
export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
