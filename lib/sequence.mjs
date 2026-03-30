import {existsSequence, addSequence, getSequence} from "./sequence_archive.mjs";

const resolve = (path, obj) =>
  path.split(".").reduce((prev, curr) => (prev ? prev[curr] : null), obj);

export default function SequenceFactory(connection) {
  if (!connection) throw new Error("Please, pass a mongoose connection to mongoose-sequence");
  const MongooseSchema = connection.Schema ?? connection.base?.Schema;
  if (!MongooseSchema) throw new Error("Cannot resolve Schema from connection");

  class Sequence {
    constructor(schema, options) {
      const defaults = {
        id: null,
        inc_field: "_id",
        start_seq: 1,
        inc_amount: 1,
        reference_fields: null,
        disable_hooks: false,
        collection_name: "counters",
        exclusive: true
      };
      this._options = {...defaults, ...options};

      if (this._options.reference_fields === null) {
        this._options.reference_fields = this._options.inc_field;
        this._useReference = false;
      } else {
        this._useReference = true;
      }

      this._options.reference_fields = [].concat(this._options.reference_fields).sort();

      if (this._useReference && !this._options.id) {
        throw new Error("Cannot use reference fields without specifying an id");
      }
      this._options.id ??= this._options.inc_field;

      this._schema = schema;
      this._counterModel = null;
    }

    static getInstance(schema, options) {
      const sequence = new Sequence(schema, options);
      const id = sequence.getId();

      sequence.enable();

      if (!existsSequence(id)) {
        addSequence(id, sequence);
      } else if (sequence._options.exclusive) {
        throw new Error(`Counter already defined for field "${id}"`);
      }

      return sequence;
    }

    enable() {
      this._counterModel = this._createCounterModel();
      this._createSchemaKeys();
      this._setMethods();
      if (!this._options.disable_hooks) this._setHooks();
    }

    getId() {
      return this._options.id;
    }

    _getCounterReferenceField(doc) {
      if (!this._useReference) return null;
      const reference = {};
      for (const field of this._options.reference_fields) {
        reference[field] = resolve(field, doc);
      }
      return reference;
    }

    _createSchemaKeys() {
      const schemaKey = this._schema.path(this._options.inc_field);
      if (!schemaKey) {
        this._schema.add({[this._options.inc_field]: "Number"});
      } else if (schemaKey.instance !== "Number") {
        throw new Error('Auto increment field already present and not of type "Number"');
      }
    }

    _createCounterModel() {
      const CounterSchema = new MongooseSchema(
        {
          id: {type: String, required: true},
          reference_value: {type: MongooseSchema.Types.Mixed, required: true},
          seq: {type: Number, default: this._options.start_seq, required: true}
        },
        {
          collection: this._options.collection_name,
          validateBeforeSave: false,
          versionKey: false,
          _id: false
        }
      );
      const modelName = `Counter_${this._options.id}`;

      if (connection.modelNames().includes(modelName)) {
        return connection.model(modelName);
      }

      CounterSchema.index({id: 1, reference_value: 1}, {unique: true});
      return connection.model(modelName, CounterSchema);
    }

    async _createCounter(doc) {
      const id = this.getId();
      const referenceValue = this._getCounterReferenceField(doc);
      const startSeq = this._options.start_seq;

      try {
        const counter = await this._counterModel.findOneAndUpdate(
          {id, reference_value: referenceValue},
          {},
          {upsert: true, new: true, setDefaultsOnInsert: true, includeResultMetadata: true}
        );
        if (counter?.lastErrorObject && !counter.lastErrorObject.updatedExisting) {
          return startSeq;
        }
        return null;
      } catch (err) {
        if (err?.code !== 11000) throw err;
        return null;
      }
    }

    async _setNextCounter(doc) {
      const id = this.getId();
      const referenceValue = this._getCounterReferenceField(doc);
      const incAmount = this._options.inc_amount;

      const counter = await this._counterModel.findOneAndUpdate(
        {id, reference_value: referenceValue},
        {$inc: {seq: incAmount}},
        {new: true, upsert: false}
      );
      return counter.seq;
    }

    _getPreSaveHook() {
      const sequence = this;
      return async function () {
        if (!this.isNew) return;
        const createSeq = await sequence._createCounter(this);
        if (createSeq !== null) {
          this.set(sequence._options.inc_field, createSeq);
        } else {
          const setSeq = await sequence._setNextCounter(this);
          this.set(sequence._options.inc_field, setSeq);
        }
      };
    }

    _setHooks() {
      this._schema.pre("save", this._getPreSaveHook());
    }

    _setMethods() {
      const self = this;

      this._schema.method("setNext", async function (id) {
        const sequence = getSequence(id);
        if (!sequence) throw new Error(`Trying to increment a wrong sequence using the id ${id}`);

        const createSeq = await sequence._createCounter(this);
        if (createSeq !== null) {
          this.set(sequence._options.inc_field, createSeq);
        } else {
          const setSeq = await sequence._setNextCounter(this);
          this.set(sequence._options.inc_field, setSeq);
        }
        return this.save();
      });

      this._schema.static("counterReset", async (id, reference) => {
        const sequence = getSequence(id);
        const condition = {id};
        if (reference) {
          condition.reference_value = sequence._getCounterReferenceField(reference);
        }
        const seq = self._options.start_seq ? self._options.start_seq - 1 : 0;
        return self._counterModel.updateMany(condition, {$set: {seq}});
      });
    }

    async _resetCounter(id, reference) {
      const condition = {id};
      if (reference) {
        condition.reference_value = this._getCounterReferenceField(reference);
      }
      const seq = this._options.start_seq ? this._options.start_seq - 1 : 0;
      return this._counterModel.updateMany(condition, {$set: {seq}});
    }
  }

  return Sequence.getInstance;
}
