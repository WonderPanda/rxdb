/**
 * this is the query-builder
 * it basically uses mquery with a few overwrites
 */

import {
    default as MQuery
} from './mquery/mquery';
import * as util from './util';
import * as RxDocument from './RxDocument';

const defaultQuery = {
    _id: {}
};

let _queryCount = 0;
const newQueryID = function() {
    return ++_queryCount;
};


class RxQuery {
    constructor(op, queryObj = defaultQuery, collection) {
        this.op = op;
        this.collection = collection;
        this.defaultQuery = false;
        this.id = newQueryID();

        // force _id
        if (!queryObj._id)
            queryObj._id = {};

        this.mquery = new MQuery(queryObj);


        this.results$ = new util.Rx.BehaviorSubject(null);

        /**
         * if this is true, the results-state is not equal to the database
         * which means that the query must run agains the database again
         * @type {Boolean}
         */
        this.mustReExec = true;
    }

    // returns a clone of this RxQuery
    _clone() {
        const cloned = new RxQuery(this.op, defaultQuery, this.collection);
        cloned.mquery = this.mquery.clone();
        return cloned;
    }

    /**
     * run this query through the QueryCache
     * @return {RxQuery} can be this or another query with the equal state
     */
    _tunnelQueryCache() {
        return this.collection._queryCache.getByQuery(this);
    }

    toString() {
        if (!this.stringRep) {
            const stringObj = util.sortObject({
                op: this.op,
                options: this.mquery.options,
                _conditions: this.mquery._conditions,
                _path: this.mquery._path,
                _fields: this.mquery._fields
            }, true);
            this.stringRep = JSON.stringify(stringObj);
        }
        return this.stringRep;
    }

    /**
     * TODO
     * @param {ChangeEvent}
     */
    _handleChangeEvent(changeEvent) {
      

    }

    // observe the result of this query
    get $() {
        if (!this._subject) {
            this._subject = new util.Rx.BehaviorSubject(null);
            this._obsRunning = false;
            const collection$ = this.collection.$
                .filter(cEvent => ['INSERT', 'UPDATE', 'REMOVE'].includes(cEvent.data.op))
                .startWith(1)
                .filter(x => !this._obsRunning)
                .do(x => this._obsRunning = true)
                .mergeMap(async(cEvent) => {
                    const docs = await this.collection._pouchFind(this);
                    return docs;
                })
                .do(x => this._obsRunning = false)
                .distinctUntilChanged((prev, now) => {
                    return util.fastUnsecureHash(prev) == util.fastUnsecureHash(now);
                })
                .map(docs => this.collection._createDocuments(docs))
                .do(docs => this._subject.next(docs))
                .map(x => '');

            this._observable$ = util.Rx.Observable.merge(
                    this._subject,
                    collection$
                )
                .filter(x => (typeof x != 'string' || x != ''));
        }
        return this._observable$;
    }


    toJSON() {
        const json = {
            selector: this.mquery._conditions
        };

        let options = this.mquery._optionsForExec();

        // sort
        if (options.sort) {
            const sortArray = [];
            Object.keys(options.sort).map(fieldName => {
                const dirInt = options.sort[fieldName];
                let dir = 'asc';
                if (dirInt == -1) dir = 'desc';
                const pushMe = {};
                // TODO run primary-swap somewhere else
                if (fieldName == this.collection.schema.primaryPath)
                    fieldName = '_id';

                pushMe[fieldName] = dir;
                sortArray.push(pushMe);
            });
            json.sort = sortArray;
        }

        if (options.limit) {
            if (typeof options.limit !== 'number') throw new TypeError('limit() must get a number');
            json.limit = options.limit;
        }

        if (options.skip) {
            if (typeof options.skip !== 'number') throw new TypeError('skip() must get a number');
            json.skip = options.skip;
        }

        // add not-query to _id to prevend the grabbing of '_design..' docs
        // this is not the best solution because it prevents the usage of a 'language'-field
        if (!json.selector.language) json.selector.language = {};
        json.selector.language.$ne = 'query';


        // primary swap
        if (
            this.collection.schema.primaryPath &&
            json.selector[this.collection.schema.primaryPath]
        ) {
            const primPath = this.collection.schema.primaryPath;

            // selector
            json.selector._id = json.selector[primPath];
            delete json.selector[primPath];
        }

        return json;
    };

    /**
     * get the key-compression version of this query
     * @return {{selector: {}, sort: []}} compressedQuery
     */
    keyCompress() {
        return this
            .collection
            ._keyCompressor
            .compressQuery(this.toJSON());
    }

    /**
     * deletes all found documents
     * @return {Promise(RxDocument|RxDocument[])} promise with deleted documents
     */
    async remove() {
        const docs = await this.exec();
        if (Array.isArray(docs)) {
            await Promise.all(
                docs.map(doc => doc.remove())
            );
        } else {
            // via findOne()
            await docs.remove();
        }
        return docs;
    }

    async exec() {
        let docs, ret, doc;
        switch (this.op) {
            case 'find':
                docs = await this.collection._pouchFind(this);
                ret = this.collection._createDocuments(docs);
                return ret;
                break;
            case 'findOne':
                docs = await this.collection._pouchFind(this, 1);
                if (docs.length === 0) return null;
                doc = docs.shift();
                ret = this.collection._createDocument(doc);
                return ret;
                break;
            default:
                throw new Error(`RxQuery.exec(): op (${this.op}) not known`);
        }
    }

    /**
     * regex cannot run on primary _id
     * @link https://docs.cloudant.com/cloudant_query.html#creating-selector-expressions
     */
    regex(params) {
        if (this.mquery._path == this.collection.schema.primaryPath)
            throw new Error(`You cannot use .regex() on the primary field '${this.mquery._path}'`);

        this.mquery.regex(params);
        return this;
    };

    /**
     * make sure it searches index because of pouchdb-find bug
     * @link https://github.com/nolanlawson/pouchdb-find/issues/204
     */
    sort(params) {
        const clonedThis = this._clone();

        // workarround because sort wont work on unused keys
        if (typeof params !== 'object') {
            const checkParam = params.charAt(0) == '-' ? params.substring(1) : params;
            if (!clonedThis.mquery._conditions[checkParam])
                clonedThis.mquery.where(checkParam).gt(null);
        } else {
            Object.keys(params)
                .filter(k => !clonedThis.mquery._conditions[k] || !clonedThis.mquery._conditions[k].$gt)
                .forEach(k => {
                    const schemaObj = clonedThis.collection.schema.getSchemaByObjectPath(k);
                    if (schemaObj.type == 'integer')
                        clonedThis.mquery.where(k).gt(-Infinity);
                    else clonedThis.mquery.where(k).gt(null);
                });
        }
        clonedThis.mquery.sort(params);
        return clonedThis._tunnelQueryCache();
    };

    limit(amount) {
        if (this.op == 'findOne')
            throw new Error('.limit() cannot be called on .findOne()');
        else {
            const clonedThis = this._clone();
            clonedThis.mquery.limit(amount);
            return clonedThis._tunnelQueryCache();
        }
    }
}

// tunnel the proto-functions of mquery to RxQuery
const protoMerge = function(rxQueryProto, mQueryProto) {
    Object.keys(mQueryProto)
        .filter(attrName => !attrName.startsWith('_'))
        .filter(attrName => !rxQueryProto[attrName])
        .forEach(attrName => {
            rxQueryProto[attrName] = function(p1) {
                const clonedThis = this._clone();
                clonedThis.mquery[attrName](p1);
                return clonedThis._tunnelQueryCache();
            };
        });
};

let protoMerged = false;
export function create(op, queryObj = defaultQuery, collection) {
    if (typeof queryObj !== 'object')
        throw new TypeError('query must be an object');
    if (Array.isArray(queryObj))
        throw new TypeError('query cannot be an array');

    const ret = new RxQuery(op, queryObj, collection);

    if (!protoMerged) {
        protoMerged = true;
        protoMerge(Object.getPrototypeOf(ret), Object.getPrototypeOf(ret.mquery));
    }

    return ret;
}
