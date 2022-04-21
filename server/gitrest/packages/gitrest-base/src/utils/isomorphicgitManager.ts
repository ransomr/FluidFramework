/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import * as isomorphicGit from "isomorphic-git";
import winston from "winston";
import safeStringify from "json-stringify-safe";
import type * as resources from "@fluidframework/gitresources";
import { NetworkError } from "@fluidframework/server-services-client";
import * as helpers from "./helpers";
import * as conversions from "./isomorphicgitConversions";
import {
    IRepositoryManagerFactory,
    IExternalWriterConfig,
    IRepositoryManager,
    IFileSystemManager,
    IFileSystemManagerFactory,
    IRepoManagerParams,
    IStorageDirectoryConfig,
} from "./definitions";

export class IsomorphicGitRepositoryManager implements IRepositoryManager {
    constructor(
        private readonly fileSystemManager: IFileSystemManager,
        private readonly repoOwner: string,
        private readonly repoName: string,
        private readonly directory: string,
    ) {}

    public get path(): string {
        return this.directory;
    }

    public async getCommit(sha: string): Promise<resources.ICommit> {
        console.log(`[Isomorphic-Git] ReadCommit`);
        const commit = await isomorphicGit.readCommit({
                fs: this.fileSystemManager,
                gitdir: this.directory,
                oid: sha,
            });
        return conversions.commitToICommit(commit);
    }

    public async getCommits(
        sha: string,
        count: number,
        externalWriterConfig?: IExternalWriterConfig,
    ): Promise<resources.ICommitDetails[]> {
        try {
            console.log(`[Isomorphic-Git] log`);
            const commits = await isomorphicGit.log({
                fs: this.fileSystemManager,
                gitdir: this.directory,
                ref: sha,
                depth: count,
            });

            return commits.map((rawCommit) => {
                const gitCommit = conversions.commitToICommit(rawCommit);
                const result: resources.ICommitDetails =
                {
                    commit: {
                        author: gitCommit.author,
                        committer: gitCommit.committer,
                        message: gitCommit.message,
                        tree: gitCommit.tree,
                        url: gitCommit.url,
                    },
                    parents: gitCommit.parents,
                    sha: gitCommit.sha,
                    url: "",

                };
                return result;
            });
        } catch (err) {
            winston.info(`getCommits error: ${err}`);
            throw new NetworkError(500, "Unable to get commits.");
        }
    }

    private async getTreeInternal(sha: string): Promise<resources.ITree> {
        console.log(`[Isomorphic-Git] readTree`);
        const readTreeResult = await isomorphicGit.readTree({
            fs: this.fileSystemManager,
            gitdir: this.directory,
            oid: sha,
        });

        const entries = readTreeResult.tree;
        const outputEntries: resources.ITreeEntry[] = [];
        for (const entry of entries) {
            const output = conversions.treeEntryToITreeEntry(entry);
            outputEntries.push(output);
        }

        return {
            sha: readTreeResult.oid,
            tree: outputEntries,
            url: "",
        };
    }

    private async getTreeInternalRecursive(sha: string): Promise<resources.ITree> {
        const mapFunction: isomorphicGit.WalkerMap = async (filepath, [walkerEntry]) => {
            if (filepath !== "." && filepath !== "..") {
                const type = await walkerEntry.type();
                const mode = (await walkerEntry.mode()).toString(8);
                const oid = await walkerEntry.oid();
                return {
                    type,
                    mode,
                    oid,
                    path: filepath,
                };
            }
        };
        console.log(`[Isomorphic-Git] TREE`);
        const root = isomorphicGit.TREE({ ref: sha });
        console.log(`[Isomorphic-Git] walk`);
        const results = await isomorphicGit.walk({
            fs: this.fileSystemManager,
            gitdir: this.directory,
            trees: [root],
            map: mapFunction,
        });

        const entries = results as isomorphicGit.TreeEntry[];
        const outputEntries: resources.ITreeEntry[] = [];

        for (const entry of entries) {
            const output = conversions.treeEntryToITreeEntry(entry);
            outputEntries.push(output);
        }

        return {
            sha,
            tree: outputEntries,
            url: "",
        };
    }

    public async getTree(rootSha: string, recursive: boolean): Promise<resources.ITree> {
        if (recursive) {
            return this.getTreeInternalRecursive(rootSha);
        }
        return this.getTreeInternal(rootSha);
    }

    public async getBlob(sha: string): Promise<resources.IBlob> {
        console.log(`[Isomorphic-Git] readBlob`);
        const blob = await isomorphicGit.readBlob({
                fs: this.fileSystemManager,
                gitdir: this.directory,
                oid: sha,
            });
        return conversions.blobToIBlob(blob, this.repoOwner, this.repoName);
    }

    public async getContent(commit: string, contentPath: string): Promise<resources.IBlob> {
        console.log(`[Isomorphic-Git] readBlob`);
        const blob = await isomorphicGit.readBlob({
                fs: this.fileSystemManager,
                gitdir: this.directory,
                oid: commit,
                filepath: contentPath,
            });
        return conversions.blobToIBlob(blob, this.repoOwner, this.repoName);
    }

    public async createBlob(createBlobParams: resources.ICreateBlobParams): Promise<resources.ICreateBlobResponse> {
        if (!helpers.validateBlobContent(createBlobParams.content) ||
            !helpers.validateBlobEncoding(createBlobParams.encoding)) {
            throw new NetworkError(400, "Invalid blob");
        }
        console.log(`[Isomorphic-Git] writeBlob`);
        const blobOid = await isomorphicGit.writeBlob({
            fs: this.fileSystemManager,
            gitdir: this.directory,
            blob: Buffer.from(createBlobParams.content, createBlobParams.encoding),
        });

        return {
            sha: blobOid,
            url: `/repos/${this.repoOwner}/${this.repoName}/git/blobs/${blobOid}`,
        };
    }

    public async createTree(params: resources.ICreateTreeParams): Promise<resources.ITree> {
        const isoGitTreeObject: isomorphicGit.TreeObject = [];

        // build up the tree
        for (const node of params.tree) {
            isoGitTreeObject.push(conversions.iCreateTreeEntryToTreeEntry(node));
        }

        console.log(`[Isomorphic-Git] writeTree`);
        const id = await isomorphicGit.writeTree({
            fs: this.fileSystemManager,
            gitdir: this.directory,
            tree: isoGitTreeObject,
        });
        return this.getTreeInternal(id);
    }

    public async createCommit(commit: resources.ICreateCommitParams): Promise<resources.ICommit> {
        const commitObject = conversions.iCreateCommitParamsToCommitObject(commit);
        console.log(`[Isomorphic-Git] writeCommit`);
        const commitOid = await isomorphicGit.writeCommit({
            fs: this.fileSystemManager,
            gitdir: this.directory,
            commit: commitObject,
        });

        return {
            author: commit.author,
            committer: commit.author,
            message: commit.message,
            parents: commitObject.parent ? commit.parents.map((parent) => ({ sha: parent, url: "" })) : [],
            sha: commitOid,
            tree: {
                sha: commit.tree,
                url: "",
            },
            url: "",
        };
    }

    public async getRefs(): Promise<resources.IRef[]> {
        const refIds: string[] = [];
        console.log(`[Isomorphic-Git] listBranches and listTags`);
        const [branches, tags] = await Promise.all([
            isomorphicGit.listBranches({
                fs: this.fileSystemManager,
                gitdir: this.directory,
            }),
            isomorphicGit.listTags({
                fs: this.fileSystemManager,
                gitdir: this.directory,
            }),
        ]);

        refIds.push(...branches, ...tags);

        console.log(`[Isomorphic-Git] resolveRef and expandRef`);
        const resolvedAndExpandedRefs = await Promise.all(
            refIds.map(
                async (refId) => {
                    const [resolvedRef, expandedRef] = await Promise.all([
                        isomorphicGit.resolveRef({
                            fs: this.fileSystemManager,
                            gitdir: this.directory,
                            ref: refId,
                        }),
                        isomorphicGit.expandRef({
                            fs: this.fileSystemManager,
                            gitdir: this.directory,
                            ref: refId,
                        }),
                    ]);
                    return {
                        resolvedRef,
                        expandedRef,
                    };
                }));

        return resolvedAndExpandedRefs.map(
            (resolvedAndExpandedRef) =>
                conversions.refToIRef(
                    resolvedAndExpandedRef.resolvedRef,
                    resolvedAndExpandedRef.expandedRef));
    }

    public async getRef(refId: string, externalWriterConfig?: IExternalWriterConfig): Promise<resources.IRef> {
        try {
            console.log(`[Isomorphic-Git] resolveRef and expandRef`);
            const [resolvedRef, expandedRef] = await Promise.all([
                isomorphicGit.resolveRef({
                    fs: this.fileSystemManager,
                    gitdir: this.directory,
                    ref: refId,
                }),
                isomorphicGit.expandRef({
                    fs: this.fileSystemManager,
                    gitdir: this.directory,
                    ref: refId,
                }),
            ]);
            return conversions.refToIRef(resolvedRef, expandedRef);
        } catch (err) {
            winston.error(`getRef error: ${safeStringify(err, undefined, 2)} repo: ${this.repoName} ref: ${refId}`);
            throw new NetworkError(500, "Unable to get ref.");
        }
    }

    public async createRef(
        createRefParams: resources.ICreateRefParams,
        externalWriterConfig?: IExternalWriterConfig,
    ): Promise<resources.IRef> {
        console.log(`[Isomorphic-Git] writeRef`);
        await isomorphicGit.writeRef({
            fs: this.fileSystemManager,
            gitdir: this.directory,
            ref: createRefParams.ref,
            value: createRefParams.sha,
        });
        return conversions.refToIRef(createRefParams.sha, createRefParams.ref);
    }

    public async patchRef(
        refId: string,
        patchRefParams: resources.IPatchRefParams,
        externalWriterConfig?: IExternalWriterConfig,
    ): Promise<resources.IRef> {
        console.log(`[Isomorphic-Git] writeRef`);
        await isomorphicGit.writeRef({
            fs: this.fileSystemManager,
            gitdir: this.directory,
            ref: refId,
            value: patchRefParams.sha,
            force: true, // Isomorphic-Git requires force to be always true if we want to overwrite a ref.
        });
        return conversions.refToIRef(patchRefParams.sha, refId);
    }

    public async deleteRef(refId: string): Promise<void> {
        try {
            console.log(`[Isomorphic-Git] deleteRef`);
            await isomorphicGit.deleteRef({
                fs: this.fileSystemManager,
                gitdir: this.directory,
                ref: refId,
            });
        } catch (e: any) {
            throw new NetworkError(500, `Failed to delete ref. Error: ${e}`);
        }
    }

    public async getTag(tagId: string): Promise<resources.ITag> {
        console.log(`[Isomorphic-Git] readTag`);
        const readTagResult = await isomorphicGit.readTag({
            fs: this.fileSystemManager,
            gitdir: this.directory,
            oid: tagId,
        });
        return conversions.tagToITag(readTagResult);
    }

    public async createTag(tagParams: resources.ICreateTagParams): Promise<resources.ITag> {
        const tagObject = conversions.iCreateTagParamsToTagObject(tagParams);
        console.log(`[Isomorphic-Git] writeTag`);
        const tagOid = await isomorphicGit.writeTag({
            fs: this.fileSystemManager,
            gitdir: this.directory,
            tag: tagObject,
        });
        return this.getTag(tagOid);
    }
}

export class IsomorphicGitManagerFactory implements IRepositoryManagerFactory {
    private readonly repositoryCache: Set<string> = new Set();

    constructor(
        private readonly storageDirectoryConfig: IStorageDirectoryConfig,
        private readonly fileSystemManagerFactory: IFileSystemManagerFactory,
    ) { }

    public async create(params: IRepoManagerParams): Promise<IsomorphicGitRepositoryManager> {
        // Verify that both inputs are valid folder names
        const repoPath = helpers.getRepoPath(
            params.repoName,
            this.storageDirectoryConfig.useRepoOwner ? params.repoOwner : undefined);
        const fileSystemManager = this.fileSystemManagerFactory.create(params.fileSystemManagerParams);
        const directoryPath = helpers.getGitDirectory(
            repoPath,
            this.storageDirectoryConfig.baseDir);
        console.log(`[Isomorphic-Git] Creating repo, calling Init: ${directoryPath}`);
        // Create and then cache the repository
        await isomorphicGit.init({
            fs: fileSystemManager,
            gitdir: directoryPath,
            bare: true,
        });

        this.repositoryCache.add(repoPath);
        const repoManager = new IsomorphicGitRepositoryManager(
            fileSystemManager,
            params.repoOwner,
            params.repoName,
            directoryPath);
        winston.info(`Created a new repo for owner ${params.repoOwner} reponame: ${params.repoName}`);

        return repoManager;
    }

    public async open(params: IRepoManagerParams): Promise<IsomorphicGitRepositoryManager> {
        const repoPath = helpers.getRepoPath(
            params.repoName,
            this.storageDirectoryConfig.useRepoOwner ? params.repoOwner : undefined);
        const directoryPath = helpers.getGitDirectory(
            repoPath,
            this.storageDirectoryConfig.baseDir);
        const fileSystemManager = this.fileSystemManagerFactory.create(params.fileSystemManagerParams);

        if (!(this.repositoryCache.has(repoPath))) {
            const repoExists = await helpers.exists(fileSystemManager, directoryPath);
            if (!repoExists || !repoExists.isDirectory()) {
                winston.info(`Repo does not exist ${directoryPath}`);
                // services-client/getOrCreateRepository depends on a 400 response code
                throw new NetworkError(400, `Repo does not exist ${directoryPath}`);
            }

            this.repositoryCache.add(repoPath);
        }

        const repoManager = new IsomorphicGitRepositoryManager(
            fileSystemManager,
            params.repoOwner,
            params.repoName,
            directoryPath);
        return repoManager;
    }
}
