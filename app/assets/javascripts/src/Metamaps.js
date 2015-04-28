var labelType, useGradients, nativeTextSupport, animate;

(function () {
    var ua = navigator.userAgent,
        iStuff = ua.match(/iPhone/i) || ua.match(/iPad/i),
        typeOfCanvas = typeof HTMLCanvasElement,
        nativeCanvasSupport = (typeOfCanvas == 'object' || typeOfCanvas == 'function'),
        textSupport = nativeCanvasSupport && (typeof document.createElement('canvas').getContext('2d').fillText == 'function');
    //I'm setting this based on the fact that ExCanvas provides text support for IE
    //and that as of today iPhone/iPad current text support is lame
    labelType = (!nativeCanvasSupport || (textSupport && !iStuff)) ? 'Native' : 'HTML';
    nativeTextSupport = labelType == 'Native';
    useGradients = nativeCanvasSupport;
    animate = !(iStuff || !nativeCanvasSupport);
})();

// TODO eliminate these 4 global variables
var panningInt; // this variable is used to store a 'setInterval' for the Metamaps.JIT.SmoothPanning() function, so that it can be cleared with window.clearInterval
var tempNode = null,
    tempInit = false,
    tempNode2 = null;

Metamaps.Settings = {
    embed: false, // indicates that the app is on a page that is optimized for embedding in iFrames on other web pages
    sandbox: false, // puts the app into a mode (when true) where it only creates data locally, and isn't writing it to the database
    colors: {
        background: '#344A58',
        synapses: {
            normal: '#888888',
            hover: '#888888',
            selected: '#FFFFFF'
        },
        topics: {
            selected: '#FFFFFF'
        },
        labels: {
            background: '#18202E',
            text: '#DDD'
        }
    }
};

Metamaps.Touch = {
    touchPos: null, // this stores the x and y values of a current touch event 
    touchDragNode: null // this stores a reference to a JIT node that is being dragged
};

Metamaps.Mouse = {
    didPan: false,
    didBoxZoom: false,
    changeInX: 0,
    changeInY: 0,
    edgeHoveringOver: false,
    boxStartCoordinates: false,
    boxEndCoordinates: false,
    synapseStartCoordinates: [],
    synapseEndCoordinates: null,
    lastNodeClick: 0,
    lastCanvasClick: 0,
    DOUBLE_CLICK_TOLERANCE: 300
};

Metamaps.Selected = {
    reset: function () {
        var self = Metamaps.Selected;

        self.Nodes = [];
        self.Edges = [];
    },
    Nodes: [],
    Edges: []
};

/*
 *
 *   BACKBONE
 *
 */
Metamaps.Backbone.init = function () {
    var self = Metamaps.Backbone;

    self.Metacode = Backbone.Model.extend({
        initialize: function () {
            var image = new Image();
            image.crossOrigin = "Anonymous";
            image.src = this.get('icon');
            this.set('image',image);
        },
        prepareLiForFilter: function () {
            var li = '';
            li += '<li data-id="' + this.id.toString() + '">';      
            li += '<img src="' + this.get('icon') + '" data-id="' + this.id.toString() + '"';
            li += ' alt="' + this.get('name') + '" />';      
            li += '<p>' + this.get('name').toLowerCase() + '</p></li>';
            return li;
        }

    });
    self.MetacodeCollection = Backbone.Collection.extend({
        model: this.Metacode,
        url: '/metacodes',
        comparator: function (a, b) {
            a = a.get('name').toLowerCase();
            b = b.get('name').toLowerCase();
            return a > b ? 1 : a < b ? -1 : 0;
        }
    });

    self.Topic = Backbone.Model.extend({
        urlRoot: '/topics',
        blacklist: ['node', 'created_at', 'updated_at', 'user_name', 'user_image', 'map_count', 'synapse_count'],
        toJSON: function (options) {
            return _.omit(this.attributes, this.blacklist);
        },
        save: function (key, val, options) {
            
            var attrs;

            // Handle both `"key", value` and `{key: value}` -style arguments.
            if (key == null || typeof key === 'object') {
                attrs = key;
                options = val;
            } else {
                (attrs = {})[key] = val;
            }

            var newOptions = options || {};
            var s = newOptions.success;

            var permBefore = this.get('permission');

            newOptions.success = function (model, response, opt) {
                if (s) s(model, response, opt);
                model.trigger('saved');

                if (permBefore === 'private' && model.get('permission') !== 'private') {
                    model.trigger('noLongerPrivate');
                }
                else if (permBefore !== 'private' && model.get('permission') === 'private') {
                    model.trigger('nowPrivate');
                }
            };
            return Backbone.Model.prototype.save.call(this, attrs, newOptions);
        },
        initialize: function () {
            if (this.isNew()) {
                this.set({
                    "user_id": Metamaps.Active.Mapper.id,
                    "desc": '',
                    "link": '',
                    "permission": Metamaps.Active.Map ? Metamaps.Active.Map.get('permission') : 'commons'
                });
            }
            
            this.on('changeByOther', this.updateCardView);
            this.on('change', this.updateNodeView);
            this.on('saved', this.savedEvent);
            this.on('nowPrivate', function(){
                var removeTopicData = {
                    topicid: this.id
                };

                $(document).trigger(Metamaps.JIT.events.removeTopic, [removeTopicData]);
            });
            this.on('noLongerPrivate', function(){
                var newTopicData = {
                    mappingid: this.getMapping().id,
                    topicid: this.id
                };

                $(document).trigger(Metamaps.JIT.events.newTopic, [newTopicData]);
            });

            this.on('change:metacode_id', Metamaps.Filter.checkMetacodes, this);

        },
        authorizeToEdit: function (mapper) {
            if (mapper && (this.get('permission') === "commons" || this.get('user_id') === mapper.get('id'))) return true;
            else return false;
        },
        authorizePermissionChange: function (mapper) {
            if (mapper && this.get('user_id') === mapper.get('id')) return true;
            else return false;
        },
        getDate: function () {

        },
        getMetacode: function () {
            return Metamaps.Metacodes.get(this.get('metacode_id'));
        },
        getMapping: function () {
            
            if (!Metamaps.Active.Map) return false;
            
            return Metamaps.Mappings.findWhere({
                map_id: Metamaps.Active.Map.id,
                topic_id: this.isNew() ? this.cid : this.id
            });
        },
        createNode: function () {
            var mapping;
            var node = {
                adjacencies: [],
                id: this.isNew() ? this.cid : this.id,
                name: this.get('name')
            };
            
            if (Metamaps.Active.Map) {
                mapping = this.getMapping();
                node.data = {
                    $mapping: null,
                    $mappingID: mapping.id
                };
            }
            
            return node;
        },
        updateNode: function () {
            var mapping;
            var node = this.get('node');
            node.setData('topic', this);
            
            if (Metamaps.Active.Map) {
                mapping = this.getMapping();
                node.setData('mapping', mapping);
            }
            
            return node;
        },
        savedEvent: function() {
            Metamaps.Realtime.sendTopicChange(this);
        },
        updateViews: function() {
            var onPageWithTopicCard = Metamaps.Active.Map || Metamaps.Active.Topic;
            var node = this.get('node');
            // update topic card, if this topic is the one open there
            if (onPageWithTopicCard && this == Metamaps.TopicCard.openTopicCard) {
                Metamaps.TopicCard.showCard(node);
            }

            // update the node on the map
            if (onPageWithTopicCard && node) {
                node.name = this.get('name'); 
                Metamaps.Visualize.mGraph.plot();
            }
        },
        updateCardView: function() {
            var onPageWithTopicCard = Metamaps.Active.Map || Metamaps.Active.Topic;
            var node = this.get('node');
            // update topic card, if this topic is the one open there
            if (onPageWithTopicCard && this == Metamaps.TopicCard.openTopicCard) {
                Metamaps.TopicCard.showCard(node);
            }
        },
        updateNodeView: function() {
            var onPageWithTopicCard = Metamaps.Active.Map || Metamaps.Active.Topic;
            var node = this.get('node');

            // update the node on the map
            if (onPageWithTopicCard && node) {
                node.name = this.get('name'); 
                Metamaps.Visualize.mGraph.plot();
            }
        }
    });

    self.TopicCollection = Backbone.Collection.extend({
        model: self.Topic,
        url: '/topics'
    });

    self.Synapse = Backbone.Model.extend({
        urlRoot: '/synapses',
        blacklist: ['edge', 'created_at', 'updated_at'],
        toJSON: function (options) {
            return _.omit(this.attributes, this.blacklist);
        },
        save: function (key, val, options) {
            
            var attrs;

            // Handle both `"key", value` and `{key: value}` -style arguments.
            if (key == null || typeof key === 'object') {
                attrs = key;
                options = val;
            } else {
                (attrs = {})[key] = val;
            }

            var newOptions = options || {};
            var s = newOptions.success;

            var permBefore = this.get('permission');

            newOptions.success = function (model, response, opt) {
                if (s) s(model, response, opt);
                model.trigger('saved');

                if (permBefore === 'private' && model.get('permission') !== 'private') {
                    model.trigger('noLongerPrivate');
                }
                else if (permBefore !== 'private' && model.get('permission') === 'private') {
                    model.trigger('nowPrivate');
                }
            };
            return Backbone.Model.prototype.save.call(this, attrs, newOptions);
        },
        initialize: function () {
            if (this.isNew()) {
                this.set({
                    "user_id": Metamaps.Active.Mapper.id,
                    "permission": Metamaps.Active.Map ? Metamaps.Active.Map.get('permission') : 'commons',
                    "category": "from-to"
                });
            }

            this.on('changeByOther', this.updateCardView);
            this.on('change', this.updateEdgeView);
            this.on('saved', this.savedEvent);
            this.on('noLongerPrivate', function(){
                var newSynapseData = {
                    mappingid: this.getMapping().id,
                    synapseid: this.id
                };

                $(document).trigger(Metamaps.JIT.events.newSynapse, [newSynapseData]);
            });
            this.on('nowPrivate', function(){
                $(document).trigger(Metamaps.JIT.events.removeSynapse, [{
                    synapseid: this.id
                }]);
            });

            this.on('change:desc', Metamaps.Filter.checkSynapses, this);
        },
        prepareLiForFilter: function () {
            var li = '';
            li += '<li data-id="' + this.get('desc') + '">';      
            li += '<img src="/assets/synapse16.png"';
            li += ' alt="synapse icon" />';      
            li += '<p>' + this.get('desc') + '</p></li>';
            return li;
        },
        authorizeToEdit: function (mapper) {
            if (mapper && (this.get('permission') === "commons" || this.get('user_id') === mapper.get('id'))) return true;
            else return false;
        },
        authorizePermissionChange: function (mapper) {
            if (mapper && this.get('user_id') === mapper.get('id')) return true;
            else return false;
        },
        getTopic1: function () {
            return Metamaps.Topics.get(this.get('node1_id'));
        },
        getTopic2: function () {
            return Metamaps.Topics.get(this.get('node2_id'));
        },
        getDirection: function () {
            var t1 = this.getTopic1(),
                t2 = this.getTopic2();

            return t1 && t2 ? [
                    t1.get('node').id,
                    t2.get('node').id
                ] : false;
        },
        getMapping: function () {
            
            if (!Metamaps.Active.Map) return false;
            
            return Metamaps.Mappings.findWhere({
                map_id: Metamaps.Active.Map.id,
                synapse_id: this.isNew() ? this.cid : this.id
            });
        },
        createEdge: function () {
            var mapping, mappingID;
            var synapseID = this.isNew() ? this.cid : this.id;

            var edge = {
                nodeFrom: this.get('node1_id'),
                nodeTo: this.get('node2_id'),
                data: {
                    $synapses: [],
                    $synapseIDs: [synapseID],
                }
            };
            
            if (Metamaps.Active.Map) {
                mapping = this.getMapping();
                mappingID = mapping.isNew() ? mapping.cid : mapping.id;
                edge.data.$mappings = [];
                edge.data.$mappingIDs = [mappingID];
            }
            
            return edge;
        },
        updateEdge: function () {
            var mapping;
            var edge = this.get('edge');
            edge.getData('synapses').push(this);
            
            if (Metamaps.Active.Map) {
                mapping = this.getMapping();
                edge.getData('mappings').push(mapping);
            }
            
            return edge;
        },
        savedEvent: function() {
            Metamaps.Realtime.sendSynapseChange(this);
        },
        updateViews: function() {
            this.updateCardView();
            this.updateEdgeView();
        },
        updateCardView: function() {
            var onPageWithSynapseCard = Metamaps.Active.Map || Metamaps.Active.Topic;
            var edge = this.get('edge');

            // update synapse card, if this synapse is the one open there
            if (onPageWithSynapseCard && edge == Metamaps.SynapseCard.openSynapseCard) {
                Metamaps.SynapseCard.showCard(edge);
            }
        },
        updateEdgeView: function() {
            var onPageWithSynapseCard = Metamaps.Active.Map || Metamaps.Active.Topic;
            var edge = this.get('edge');

            // update the edge on the map
            if (onPageWithSynapseCard && edge) {
                Metamaps.Visualize.mGraph.plot();
            }
        }
    });

    self.SynapseCollection = Backbone.Collection.extend({
        model: self.Synapse,
        url: '/synapses'
    });

    self.Mapping = Backbone.Model.extend({
        urlRoot: '/mappings',
        blacklist: ['created_at', 'updated_at'],
        toJSON: function (options) {
            return _.omit(this.attributes, this.blacklist);
        },
        initialize: function () {
            if (this.isNew()) {
                this.set({
                    "user_id": Metamaps.Active.Mapper.id,
                    "map_id": Metamaps.Active.Map ? Metamaps.Active.Map.id : null
                });
            }
        },
        getMap: function () {
            return Metamaps.Map.get(this.get('map_id'));
        },
        getTopic: function () {
            if (this.get('category') === 'Topic') return Metamaps.Topic.get(this.get('topic_id'));
            else return false;
        },
        getSynapse: function () {
            if (this.get('category') === 'Synapse') return Metamaps.Synapse.get(this.get('synapse_id'));
            else return false;
        }
    });

    self.MappingCollection = Backbone.Collection.extend({
        model: self.Mapping,
        url: '/mappings'
    });

    Metamaps.Metacodes = Metamaps.Metacodes ? new self.MetacodeCollection(Metamaps.Metacodes) : new self.MetacodeCollection();

    Metamaps.Topics = Metamaps.Topics ? new self.TopicCollection(Metamaps.Topics) : new self.TopicCollection();

    Metamaps.Synapses = Metamaps.Synapses ? new self.SynapseCollection(Metamaps.Synapses) : new self.SynapseCollection();

    Metamaps.Mappers = Metamaps.Mappers ? new self.MapperCollection(Metamaps.Mappers) : new self.MapperCollection();

    // this is for topic view
    Metamaps.Creators = Metamaps.Creators ? new self.MapperCollection(Metamaps.Creators) : new self.MapperCollection();

    if (Metamaps.Active.Map) {
        Metamaps.Mappings = Metamaps.Mappings ? new self.MappingCollection(Metamaps.Mappings) : new self.MappingCollection();

        Metamaps.Active.Map = new self.Map(Metamaps.Active.Map);
    }
    
    if (Metamaps.Active.Topic) Metamaps.Active.Topic = new self.Topic(Metamaps.Active.Topic);

    //attach collection event listeners
    self.attachCollectionEvents = function () {
        
        Metamaps.Topics.on("add remove", function(topic){
            Metamaps.Map.InfoBox.updateNumbers();
            Metamaps.Filter.checkMetacodes();
            Metamaps.Filter.checkMappers();
        });

        Metamaps.Synapses.on("add remove", function(synapse){
            Metamaps.Map.InfoBox.updateNumbers();
            Metamaps.Filter.checkSynapses();
            Metamaps.Filter.checkMappers();
        });
        
        if (Metamaps.Active.Map) {
            Metamaps.Mappings.on("add remove", function(mapping){
                Metamaps.Map.InfoBox.updateNumbers();
                Metamaps.Filter.checkSynapses();
                Metamaps.Filter.checkMetacodes();
                Metamaps.Filter.checkMappers();
            });
        }
    }
    self.attachCollectionEvents();
}; // end Metamaps.Backbone.init


/*
 *
 *   CREATE
 *
 */
Metamaps.Create = {
    isSwitchingSet: false, // indicates whether the metacode set switch lightbox is open
    selectedMetacodeSet: null,
    selectedMetacodeSetIndex: null,
    selectedMetacodeNames: [],
    newSelectedMetacodeNames: [],
    selectedMetacodes: [],
    newSelectedMetacodes: [],
    init: function () {
        var self = Metamaps.Create;
        self.newTopic.init();
        self.newSynapse.init();

        //////
        //////
        //// SWITCHING METACODE SETS

        $('#metacodeSwitchTabs').tabs({
            selected: self.selectedMetacodeSetIndex
        }).addClass("ui-tabs-vertical ui-helper-clearfix");
        $("#metacodeSwitchTabs .ui-tabs-nav li").removeClass("ui-corner-top").addClass("ui-corner-left");
        $('.customMetacodeList li').click(self.toggleMetacodeSelected); // within the custom metacode set tab
    },
    toggleMetacodeSelected: function () {
        var self = Metamaps.Create;

        if ($(this).attr('class') != 'toggledOff') {
            $(this).addClass('toggledOff');
            var value_to_remove = $(this).attr('id');
            var name_to_remove = $(this).attr('data-name');
            self.newSelectedMetacodes.splice(self.newSelectedMetacodes.indexOf(value_to_remove), 1);
            self.newSelectedMetacodeNames.splice(self.newSelectedMetacodeNames.indexOf(name_to_remove), 1);
        } else if ($(this).attr('class') == 'toggledOff') {
            $(this).removeClass('toggledOff');
            self.newSelectedMetacodes.push($(this).attr('id'));
            self.newSelectedMetacodeNames.push($(this).attr('data-name'));
        }
    },
    updateMetacodeSet: function (set, index, custom) {

        if (custom && Metamaps.Create.newSelectedMetacodes.length == 0) {
            alert('Please select at least one metacode to use!');
            return false;
        }

        var codesToSwitchToIds;
        var metacodeModels = new Metamaps.Backbone.MetacodeCollection();
        Metamaps.Create.selectedMetacodeSetIndex = index;
        Metamaps.Create.selectedMetacodeSet = "metacodeset-" + set;

        if (!custom) {
            codesToSwitchToIds = $('#metacodeSwitchTabs' + set).attr('data-metacodes').split(',');
            $('.customMetacodeList li').addClass('toggledOff');
            Metamaps.Create.selectedMetacodes = [];
            Metamaps.Create.selectedMetacodeNames = [];
            Metamaps.Create.newSelectedMetacodes = [];
            Metamaps.Create.newSelectedMetacodeNames = [];
        }
        else if (custom) {
            // uses .slice to avoid setting the two arrays to the same actual array
            Metamaps.Create.selectedMetacodes = Metamaps.Create.newSelectedMetacodes.slice(0);
            Metamaps.Create.selectedMetacodeNames = Metamaps.Create.newSelectedMetacodeNames.slice(0);
            codesToSwitchToIds = Metamaps.Create.selectedMetacodes.slice(0);
        }

        // sort by name
        for (var i = 0; i < codesToSwitchToIds.length; i++) {
            metacodeModels.add( Metamaps.Metacodes.get(codesToSwitchToIds[i]) );
        };
        metacodeModels.sort();

        $('#metacodeImg, #metacodeImgTitle').empty();
        $('#metacodeImg').removeData('cloudcarousel');
        var newMetacodes = "";
        metacodeModels.each(function(metacode){
            newMetacodes += '<img class="cloudcarousel" width="40" height="40" src="' + metacode.get('icon') + '" data-id="' + metacode.id + '" title="' + metacode.get('name') + '" alt="' + metacode.get('name') + '"/>';
        });
            
        $('#metacodeImg').empty().append(newMetacodes).CloudCarousel({
            titleBox: $('#metacodeImgTitle'),
            yRadius: 40,
            xRadius: 190,
            xPos: 170,
            yPos: 40,
            speed: 0.3,
            mouseWheel: true,
            bringToFront: true
        });

        Metamaps.GlobalUI.closeLightbox();
        $('#topic_name').focus();

        var mdata = {
            "metacodes": {
                "value": custom ? Metamaps.Create.selectedMetacodes.toString() : Metamaps.Create.selectedMetacodeSet
            }
        };
        $.ajax({
            type: "POST",
            dataType: 'json',
            url: "/user/updatemetacodes",
            data: mdata,
            success: function (data) {
                console.log('selected metacodes saved');
            },
            error: function () {
                console.log('failed to save selected metacodes');
            }
        });
    },

    cancelMetacodeSetSwitch: function () {
        var self = Metamaps.Create;
        self.isSwitchingSet = false;

        if (self.selectedMetacodeSet != "metacodeset-custom") {
            $('.customMetacodeList li').addClass('toggledOff');
            self.selectedMetacodes = [];
            self.selectedMetacodeNames = [];
            self.newSelectedMetacodes = [];
            self.newSelectedMetacodeNames = [];
        } else { // custom set is selected
            // reset it to the current actual selection
            $('.customMetacodeList li').addClass('toggledOff');
            for (var i = 0; i < self.selectedMetacodes.length; i++) {
                $('#' + self.selectedMetacodes[i]).removeClass('toggledOff');
            };
            // uses .slice to avoid setting the two arrays to the same actual array
            self.newSelectedMetacodeNames = self.selectedMetacodeNames.slice(0);
            self.newSelectedMetacodes = self.selectedMetacodes.slice(0);
        }
        $('#metacodeSwitchTabs').tabs("select", self.selectedMetacodeSetIndex);
        $('#topic_name').focus();
    },
    newTopic: {
        init: function () {
            
            $('#topic_name').keyup(function () {
                Metamaps.Create.newTopic.name = $(this).val();
            });

            // initialize the autocomplete results for the metacode spinner
            $('#topic_name').typeahead([
                {
                    name: 'topic_autocomplete',
                    limit: 8,
                    template: $('#topicAutocompleteTemplate').html(),
                    remote: {
                        url: '/topics/autocomplete_topic?term=%QUERY'
                    },
                    engine: Hogan
                  }
            ]);

            // tell the autocomplete to submit the form with the topic you clicked on if you pick from the autocomplete
            $('#topic_name').bind('typeahead:selected', function (event, datum, dataset) {
                Metamaps.Topic.getTopicFromAutocomplete(datum.id);
            });

            // initialize metacode spinner and then hide it
            $("#metacodeImg").CloudCarousel({
                titleBox: $('#metacodeImgTitle'),
                yRadius: 40,
                xRadius: 190,
                xPos: 170,
                yPos: 40,
                speed: 0.3,
                mouseWheel: true,
                bringToFront: true
            });
            $('.new_topic').hide();
        },
        name: null,
        newId: 1,
        beingCreated: false,
        metacode: null,
        x: null,
        y: null,
        addSynapse: false,
        open: function () {
            $('#new_topic').fadeIn('fast', function () {
                $('#topic_name').focus();
            });
            Metamaps.Create.newTopic.beingCreated = true;
            Metamaps.Create.newTopic.name = "";
        },
        hide: function () {
            $('#new_topic').fadeOut('fast');
            $("#topic_name").typeahead('setQuery', '');
            Metamaps.Create.newTopic.beingCreated = false;
        }
    },
    newSynapse: {
        init: function () {
            var self = Metamaps.Create.newSynapse;

            $('#synapse_desc').keyup(function () {
                Metamaps.Create.newSynapse.description = $(this).val();
            });

            // initialize the autocomplete results for synapse creation
            $('#synapse_desc').typeahead([
                {
                    name: 'synapse_autocomplete',
                    template: "<div class='genericSynapseDesc'>{{label}}</div>",
                    remote: {
                        url: '/search/synapses?term=%QUERY'
                    },
                    engine: Hogan
                },
                {
                    name: 'existing_synapses',
                    limit: 50,
                    template: $('#synapseAutocompleteTemplate').html(),
                    remote: {
                        url: '/search/synapses',
                        replace: function () {
                            return self.getSearchQuery();
                        }
                    },
                    engine: Hogan,
                    header: "<h3>Existing synapses</h3>"
                }
          ]);

            $('#synapse_desc').bind('typeahead:selected', function (event, datum, dataset) {
                if (datum.id) { // if they clicked on an existing synapse get it
                    Metamaps.Synapse.getSynapseFromAutocomplete(datum.id);
                }
                else {
                    Metamaps.Create.newSynapse.description = datum.value;
                    Metamaps.Synapse.createSynapseLocally();
                }
            });
        },
        beingCreated: false,
        description: null,
        topic1id: null,
        topic2id: null,
        newSynapseId: null,
        open: function () {
            $('#new_synapse').fadeIn('fast', function () {
                $('#synapse_desc').focus();
            });
            Metamaps.Create.newSynapse.beingCreated = true;
        },
        hide: function () {
            $('#new_synapse').fadeOut('fast');
            $("#synapse_desc").typeahead('setQuery', '');
            Metamaps.Create.newSynapse.beingCreated = false;
            Metamaps.Create.newTopic.addSynapse = false;
            Metamaps.Create.newSynapse.topic1id = 0;
            Metamaps.Create.newSynapse.topic2id = 0;
            Metamaps.Mouse.synapseStartCoordinates = [];
            Metamaps.Visualize.mGraph.plot();
        },
        getSearchQuery: function () {
            var self = Metamaps.Create.newSynapse;

            if (Metamaps.Selected.Nodes.length < 2) {
                return '/search/synapses?topic1id=' + self.topic1id + '&topic2id=' + self.topic2id;
            } else return '';
        }
    }
}; // end Metamaps.Create


////////////////// TOPIC AND SYNAPSE CARDS //////////////////////////


/*
 *
 *   TOPICCARD
 *
 */
Metamaps.TopicCard = {
    openTopicCard: null, //stores the topic that's currently open
    authorizedToEdit: false, // stores boolean for edit permission for open topic card
    init: function () {
        var self = Metamaps.TopicCard;

        // initialize best_in_place editing
        $('.authenticated div.permission.canEdit .best_in_place').best_in_place();

        Metamaps.TopicCard.generateShowcardHTML = Hogan.compile($('#topicCardTemplate').html());

        // initialize topic card draggability and resizability
        $('.showcard').draggable({
            handle: ".metacodeImage"
        });

        embedly('on', 'card.rendered', self.embedlyCardRendered);
    },
    /**
     * Will open the Topic Card for the node that it's passed
     * @param {$jit.Graph.Node} node
     */
    showCard: function (node) {
        var self = Metamaps.TopicCard;

        var topic = node.getData('topic');

        self.openTopicCard = topic;
        self.authorizedToEdit = topic.authorizeToEdit(Metamaps.Active.Mapper);
        //populate the card that's about to show with the right topics data
        self.populateShowCard(topic);
        $('.showcard').fadeIn('fast');
    },
    hideCard: function () {
        var self = Metamaps.TopicCard;

        $('.showcard').fadeOut('fast');
        self.openTopicCard = null;
        self.authorizedToEdit = false;
    },
    embedlyCardRendered: function (iframe) {
        var self = Metamaps.TopicCard;

        $('#embedlyLinkLoader').hide();

        // means that the embedly call returned 404 not found
        if ($('#embedlyLink')[0]) {
            $('#embedlyLink').css('display', 'block').fadeIn('fast');
            $('.embeds').addClass('nonEmbedlyLink');
        }

        $('.CardOnGraph').addClass('hasAttachment');
        if (self.authorizedToEdit) {
            $('.embeds').append('<div id="linkremove"></div>');
            $('#linkremove').click(self.removeLink);
        }
    },
    removeLink: function () {
        var self = Metamaps.TopicCard;
        self.openTopicCard.save({
            link: null
        });
        $('.embeds').empty().removeClass('nonEmbedlyLink');
        $('#addLinkInput input').val("");
        $('.attachments').removeClass('hidden');
        $('.CardOnGraph').removeClass('hasAttachment');
    },
    bindShowCardListeners: function (topic) {
        var self = Metamaps.TopicCard;
        var showCard = document.getElementById('showcard');

        var authorized = self.authorizedToEdit;

        // get mapper image
        var setMapperImage = function (mapper) {
            $('.contributorIcon').attr('src', mapper.get('image'));
        };
        Metamaps.Mapper.get(topic.get('user_id'), setMapperImage);

        // starting embed.ly
        var resetFunc = function () {
            $('#addLinkInput input').val("");
            $('#addLinkInput input').focus();
        };
        var inputEmbedFunc = function (event) {
            
            var element = this;
            setTimeout(function () {
                var text = $(element).val();
                if (event.type=="paste" || (event.type=="keyup" && event.which==13)){
                    if (text.slice(0, 4) !== 'http') {
                        text='http://'+text;
                    }
                    topic.save({
                        link: text
                    });
                    var embedlyEl = $('<a/>', {
                        id: 'embedlyLink',
                        'data-card-description': '0',
                        href: text
                    }).html(text);
                    $('.attachments').addClass('hidden');
                    $('.embeds').append(embedlyEl);
                    $('.embeds').append('<div id="embedlyLinkLoader"></div>');
                    var loader = new CanvasLoader('embedlyLinkLoader');
                    loader.setColor('#4fb5c0'); // default is '#000000'
                    loader.setDiameter(28); // default is 40
                    loader.setDensity(41); // default is 40
                    loader.setRange(0.9); // default is 1.3
                    loader.show(); // Hidden by default
                    var e = embedly('card', document.getElementById('embedlyLink'));
                    if (!e) {
                        self.handleInvalidLink();
                    }
                }
            }, 100);
        };
        $('#addLinkReset').click(resetFunc);
        $('#addLinkInput input').bind("paste keyup",inputEmbedFunc);

        // initialize the link card, if there is a link
        if (topic.get('link') && topic.get('link') !== '') {
            var loader = new CanvasLoader('embedlyLinkLoader');
            loader.setColor('#4fb5c0'); // default is '#000000'
            loader.setDiameter(28); // default is 40
            loader.setDensity(41); // default is 40
            loader.setRange(0.9); // default is 1.3
            loader.show(); // Hidden by default
            var e = embedly('card', document.getElementById('embedlyLink'));
            if (!e) {
                self.handleInvalidLink();
            }
        }


        var selectingMetacode = false;
        // attach the listener that shows the metacode title when you hover over the image
        $('.showcard .metacodeImage').mouseenter(function () {
            $('.showcard .icon').css('z-index', '4');
            $('.showcard .metacodeTitle').show();
        });
        $('.showcard .linkItem.icon').mouseleave(function () {
            if (!selectingMetacode) {
                $('.showcard .metacodeTitle').hide();
                $('.showcard .icon').css('z-index', '1');
            }
        });

        var metacodeLiClick = function () {
            selectingMetacode = false;
            var metacodeId = parseInt($(this).attr('data-id'));
            var metacode = Metamaps.Metacodes.get(metacodeId);
            $('.CardOnGraph').find('.metacodeTitle').html(metacode.get('name'))
                .append('<div class="expandMetacodeSelect"></div>')
                .attr('class', 'metacodeTitle mbg' + metacode.id);
            $('.CardOnGraph').find('.metacodeImage').css('background-image', 'url(' + metacode.get('icon') + ')');
            topic.save({
                metacode_id: metacode.id
            });
            Metamaps.Visualize.mGraph.plot();
            $('.metacodeSelect').hide().removeClass('onRightEdge onBottomEdge');
            $('.metacodeTitle').hide();
            $('.showcard .icon').css('z-index', '1');
        };

        var openMetacodeSelect = function (event) {
            var windowWidth;
            var showcardLeft;
            var TOPICCARD_WIDTH = 300;
            var METACODESELECT_WIDTH = 404;
            var distanceFromEdge;

            var MAX_METACODELIST_HEIGHT = 270;
            var windowHeight;
            var showcardTop;
            var topicTitleHeight;
            var distanceFromBottom;

            if (!selectingMetacode) {
                selectingMetacode = true;

                // this is to make sure the metacode 
                // select is accessible onscreen, when opened
                // while topic card is close to the right 
                // edge of the screen
                windowWidth = $(window).width();
                showcardLeft = parseInt($('.showcard').css('left'));
                distanceFromEdge = windowWidth - (showcardLeft + TOPICCARD_WIDTH);
                if (distanceFromEdge < METACODESELECT_WIDTH) {
                    $('.metacodeSelect').addClass('onRightEdge');
                }

                // this is to make sure the metacode 
                // select is accessible onscreen, when opened
                // while topic card is close to the bottom
                // edge of the screen
                windowHeight = $(window).height();
                showcardTop = parseInt($('.showcard').css('top'));
                topicTitleHeight = $('.showcard .title').height() + parseInt($('.showcard .title').css('padding-top')) + parseInt($('.showcard .title').css('padding-bottom'));
                heightOfSetList = $('.showcard .metacodeSelect').height();
                distanceFromBottom = windowHeight - (showcardTop + topicTitleHeight);
                if (distanceFromBottom < MAX_METACODELIST_HEIGHT) {
                    $('.metacodeSelect').addClass('onBottomEdge');
                }

                $('.metacodeSelect').show();
                event.stopPropagation();
            }
        };

        var hideMetacodeSelect = function () {
            selectingMetacode = false;
            $('.metacodeSelect').hide().removeClass('onRightEdge onBottomEdge');
            $('.metacodeTitle').hide();
            $('.showcard .icon').css('z-index', '1');
        };

        if (authorized) {
            $('.showcard .metacodeTitle').click(openMetacodeSelect);
            $('.showcard').click(hideMetacodeSelect);
            $('.metacodeSelect > ul > li').click(function (event){
                event.stopPropagation();
            });
            $('.metacodeSelect li li').click(metacodeLiClick);

            var bipName = $(showCard).find('.best_in_place_name');
            bipName.bind("best_in_place:activate", function () {
                var $el = bipName.find('textarea');
                var el = $el[0];

                $el.attr('maxlength', '140');

                $('.showcard .title').append('<div class="nameCounter forTopic"></div>');

                var callback = function (data) {
                    $('.nameCounter.forTopic').html(data.all + '/140');
                };
                Countable.live(el, callback);
            });
            bipName.bind("best_in_place:deactivate", function () {
                $('.nameCounter.forTopic').remove();
            });

            //bind best_in_place ajax callbacks
            bipName.bind("ajax:success", function () {
                var name = Metamaps.Util.decodeEntities($(this).html());
                topic.set("name", name);
                topic.trigger('saved');
            });

            $(showCard).find('.best_in_place_desc').bind("ajax:success", function () {
                this.innerHTML = this.innerHTML.replace(/\r/g, '');
                var desc = $(this).html() === $(this).data('nil') ? "" : $(this).html();
                topic.set("desc", desc);
                topic.trigger('saved');
            });
        }


        var permissionLiClick = function (event) {
            selectingPermission = false;
            var permission = $(this).attr('class');
            topic.save({
                permission: permission
            });
            $('.showcard .mapPerm').removeClass('co pu pr minimize').addClass(permission.substring(0, 2));
            $('.showcard .permissionSelect').remove();
            event.stopPropagation();
        };

        var openPermissionSelect = function (event) {
            if (!selectingPermission) {
                selectingPermission = true;
                $(this).addClass('minimize'); // this line flips the drop down arrow to a pull up arrow
                if ($(this).hasClass('co')) {
                    $(this).append('<ul class="permissionSelect"><li class="public"></li><li class="private"></li></ul>');
                } else if ($(this).hasClass('pu')) {
                    $(this).append('<ul class="permissionSelect"><li class="commons"></li><li class="private"></li></ul>');
                } else if ($(this).hasClass('pr')) {
                    $(this).append('<ul class="permissionSelect"><li class="commons"></li><li class="public"></li></ul>');
                }
                $('.showcard .permissionSelect li').click(permissionLiClick);
                event.stopPropagation();
            }
        };

        var hidePermissionSelect = function () {
            selectingPermission = false;
            $('.showcard .yourTopic .mapPerm').removeClass('minimize'); // this line flips the pull up arrow to a drop down arrow
            $('.showcard .permissionSelect').remove();
        };
        // ability to change permission
        var selectingPermission = false;
        if (topic.authorizePermissionChange(Metamaps.Active.Mapper)) {
            $('.showcard .yourTopic .mapPerm').click(openPermissionSelect);
            $('.showcard').click(hidePermissionSelect);
        }

        $('.links .mapCount').unbind().click(function(event){
            $('.mapCount .tip').toggle();
            $('.showcard .hoverTip').toggleClass('hide');
            event.stopPropagation();
        });
        $('.mapCount .tip').unbind().click(function(event){
            event.stopPropagation();
        });
        $('.showcard').unbind('.hideTip').bind('click.hideTip', function(){
            $('.mapCount .tip').hide();
            $('.showcard .hoverTip').removeClass('hide');
        });

        $('.mapCount .tip li a').click(Metamaps.Router.intercept);

        var originalText = $('.showMore').html();
        $('.mapCount .tip .showMore').unbind().toggle(
            function(event){
                $('.extraText').toggleClass("hideExtra");
                $('.showMore').html('Show less...');
            },
            function(event){
                $('.extraText').toggleClass("hideExtra");
                $('.showMore').html(originalText);
            });

        $('.mapCount .tip showMore').unbind().click(function(event){
            event.stopPropagation();
        });
    },
    handleInvalidLink: function() {
        var self = Metamaps.TopicCard;

        self.removeLink();
        Metamaps.GlobalUI.notifyUser("Invalid link");
    },
    populateShowCard: function (topic) {
        var self = Metamaps.TopicCard;

        var showCard = document.getElementById('showcard');

        $(showCard).find('.permission').remove();

        var topicForTemplate = self.buildObject(topic);
        var html = self.generateShowcardHTML.render(topicForTemplate);

        if (topic.authorizeToEdit(Metamaps.Active.Mapper)) {
            var perm = document.createElement('div');

            var string = 'permission canEdit';
            if (topic.authorizePermissionChange(Metamaps.Active.Mapper)) string += ' yourTopic';
            perm.className = string;
            perm.innerHTML = html;
            showCard.appendChild(perm);
        } else {
            var perm = document.createElement('div');
            perm.className = 'permission cannotEdit';
            perm.innerHTML = html;
            showCard.appendChild(perm);
        }

        Metamaps.TopicCard.bindShowCardListeners(topic);
    },
    generateShowcardHTML: null, // will be initialized into a Hogan template within init function
    //generateShowcardHTML
    buildObject: function (topic) {
        var self=Metamaps.TopicCard;

        var nodeValues = {};
        
        var authorized = topic.authorizeToEdit(Metamaps.Active.Mapper);

        if (!authorized) {
            
        } else {
            
        }

        var desc_nil = "Click to add description...";

        nodeValues.attachmentsHidden = '';
        if (topic.get('link') && topic.get('link')!== '') {
            nodeValues.embeds = '<a href="' + topic.get('link') + '" id="embedlyLink" target="_blank" data-card-description="0">';
            nodeValues.embeds += topic.get('link');
            nodeValues.embeds += '</a><div id="embedlyLinkLoader"></div>';
            nodeValues.attachmentsHidden = 'hidden';
            nodeValues.hasAttachment = "hasAttachment";
        }
        else {
            nodeValues.embeds = '';
            nodeValues.hasAttachment = '';
        }

        if (authorized) {
            nodeValues.attachments = '<div class="addLink"><div id="addLinkIcon"></div>';
            nodeValues.attachments += '<div id="addLinkInput"><input placeholder="Enter or paste a link"></input>';
            nodeValues.attachments += '<div id="addLinkReset"></div></div></div>';
        } else {
            nodeValues.attachmentsHidden = 'hidden';
            nodeValues.attachments = '';
        }

        var inmapsAr = topic.get("inmaps");
        var inmapsLinks = topic.get("inmapsLinks");
        nodeValues.inmaps ='';
        if (inmapsAr.length < 6) {
            for (i = 0; i < inmapsAr.length; i++) {
                var url = "/maps/" + inmapsLinks[i];
                nodeValues.inmaps += '<li><a href="' + url + '">'  + inmapsAr[i]+ '</a></li>';
            }
        }
        else {
            for (i = 0; i < 5; i++){
                var url = "/maps/" + inmapsLinks[i];
                nodeValues.inmaps += '<li><a href="' + url + '">' + inmapsAr[i] + '</a></li>';
            }
            extra = inmapsAr.length - 5;
            nodeValues.inmaps += '<li><span class="showMore">See ' + extra + ' more...</span></li>'
            for (i = 5; i < inmapsAr.length; i++){
                var url = "/maps/" + inmapsLinks[i];
                nodeValues.inmaps += '<li class="hideExtra extraText"><a href="' + url + '">' + inmapsAr[i]+ '</a></li>';
            }
        }
        nodeValues.permission = topic.get("permission");
        nodeValues.mk_permission = topic.get("permission").substring(0, 2);
        nodeValues.map_count = topic.get("map_count").toString();
        nodeValues.synapse_count = topic.get("synapse_count").toString();
        nodeValues.id = topic.isNew() ? topic.cid : topic.id;
        nodeValues.metacode = topic.getMetacode().get("name");
        nodeValues.metacode_class = 'mbg' + topic.get('metacode_id');
        nodeValues.imgsrc = topic.getMetacode().get("icon");
        nodeValues.name = topic.get("name");
        nodeValues.userid = topic.get("user_id");
        nodeValues.username = topic.get("user_name");
        nodeValues.date = topic.getDate();
        // the code for this is stored in /views/main/_metacodeOptions.html.erb
        nodeValues.metacode_select = $('#metacodeOptions').html();
        nodeValues.desc_nil = desc_nil;
        nodeValues.desc = (topic.get("desc") == "" && authorized) ? desc_nil : topic.get("desc");
        return nodeValues;
    }
}; // end Metamaps.TopicCard


/*
 *
 *   SYNAPSECARD
 *
 */
Metamaps.SynapseCard = {
    openSynapseCard: null,
    showCard: function (edge, e) {
        var self = Metamaps.SynapseCard;

        //reset so we don't interfere with other edges, but first, save its x and y 
        var myX = $('#edit_synapse').css('left');
        var myY = $('#edit_synapse').css('top');
        $('#edit_synapse').remove();

        //so label is missing while editing
        Metamaps.Control.deselectEdge(edge);

        var index = edge.getData("displayIndex") ? edge.getData("displayIndex") : 0;
        var synapse = edge.getData('synapses')[index]; // for now, just get the first synapse

        //create the wrapper around the form elements, including permissions
        //classes to make best_in_place happy
        var edit_div = document.createElement('div');
        edit_div.innerHTML = '<div id="editSynUpperBar"></div><div id="editSynLowerBar"></div>';
        edit_div.setAttribute('id', 'edit_synapse');
        if (synapse.authorizeToEdit(Metamaps.Active.Mapper)) {
            edit_div.className = 'permission canEdit';
            edit_div.className += synapse.authorizePermissionChange(Metamaps.Active.Mapper) ? ' yourEdge' : '';
        } else {
            edit_div.className = 'permission cannotEdit';
        }
        $('#wrapper').append(edit_div);

        self.populateShowCard(edge, synapse);

        //drop it in the right spot, activate it
        $('#edit_synapse').css('position', 'absolute');
        if (e) {
            $('#edit_synapse').css('left', e.clientX);
            $('#edit_synapse').css('top', e.clientY);
        } else {
            $('#edit_synapse').css('left', myX);
            $('#edit_synapse').css('top', myY);
        }
        //$('#edit_synapse_name').click(); //required in case name is empty
        //$('#edit_synapse_name input').focus();
        $('#edit_synapse').show();

        self.openSynapseCard = edge;
    },

    hideCard: function () {
        $('#edit_synapse').remove();
        Metamaps.SynapseCard.openSynapseCard = null;
    },

    populateShowCard: function (edge, synapse) {
        var self = Metamaps.SynapseCard;

        self.add_synapse_count(edge);
        self.add_desc_form(synapse);
        self.add_drop_down(edge, synapse);
        self.add_user_info(synapse);
        self.add_perms_form(synapse);
        self.add_direction_form(synapse);
    },
    add_synapse_count: function (edge) {
        var count = edge.getData("synapses").length;

        $('#editSynUpperBar').append('<div id="synapseCardCount">' + count + '</div>')
    },
    add_desc_form: function (synapse) {
        var data_nil = 'Click to add description.';

        // TODO make it so that this would work even in sandbox mode,
        // currently with Best_in_place it won't

        //desc editing form
        $('#editSynUpperBar').append('<div id="edit_synapse_desc"></div>');
        $('#edit_synapse_desc').attr('class', 'best_in_place best_in_place_desc');
        $('#edit_synapse_desc').attr('data-object', 'synapse');
        $('#edit_synapse_desc').attr('data-attribute', 'desc');
        $('#edit_synapse_desc').attr('data-type', 'textarea');
        $('#edit_synapse_desc').attr('data-nil', data_nil);
        $('#edit_synapse_desc').attr('data-url', '/synapses/' + synapse.id);
        $('#edit_synapse_desc').html(synapse.get("desc"));

        //if edge data is blank or just whitespace, populate it with data_nil
        if ($('#edit_synapse_desc').html().trim() == '') {
            if (synapse.authorizeToEdit(Metamaps.Active.Mapper)) {
                $('#edit_synapse_desc').html(data_nil);
            }
            else {
                $('#edit_synapse_desc').html("(no description)");
            }
        }

        $('#edit_synapse_desc').bind("ajax:success", function () {
            var desc = $(this).html();
            if (desc == data_nil) {
                synapse.set("desc", '');
            } else {
                synapse.set("desc", desc);
            }
            synapse.trigger('saved');
            Metamaps.Control.selectEdge(synapse.get('edge'));
            Metamaps.Visualize.mGraph.plot();
        });
    },
    add_drop_down: function (edge, synapse) {
        var list, i, synapses, l, desc;

        synapses = edge.getData("synapses");
        l = synapses.length;

        if (l > 1) {
            // append the element that you click to show dropdown select
            $('#editSynUpperBar').append('<div id="dropdownSynapses"></div>');
            $('#dropdownSynapses').click(function(e){
                e.preventDefault();
                e.stopPropagation(); // stop it from immediately closing it again
                $('#switchSynapseList').toggle();
            });
            // hide the dropdown again if you click anywhere else on the synapse card
            $('#edit_synapse').click(function(){
                $('#switchSynapseList').hide();
            });

            // generate the list of other synapses
            list = '<ul id="switchSynapseList">';
            for (i = 0; i < l; i++) {
                if (synapses[i] !== synapse) { // don't add the current one to the list
                    desc = synapses[i].get('desc');
                    desc = desc === "" || desc === null ? "(no description)" : desc;
                    list += '<li data-synapse-index="' + i + '">' + desc + '</li>';
                }
            }
            list += '</ul>'
            // add the list of the other synapses
            $('#editSynLowerBar').append(list);

            // attach click listeners to list items that
            // will cause it to switch the displayed synapse 
            // when you click it
            $('#switchSynapseList li').click(function(e){
                e.stopPropagation();
                var index = parseInt($(this).attr('data-synapse-index'));
                edge.setData('displayIndex', index);
                Metamaps.Visualize.mGraph.plot();
                Metamaps.SynapseCard.showCard(edge, false);
            });
        }
    },
    add_user_info: function (synapse) {
        var u = '<div id="edgeUser" class="hoverForTip">';
        u += '<a href="/explore/mapper/' + synapse.get("user_id") + '"> <img src="" width="24" height="24" /></a>'
        u += '<div class="tip">' + synapse.get("user_name") + '</div></div>';
        $('#editSynLowerBar').append(u);

        // get mapper image
        var setMapperImage = function (mapper) {
            $('#edgeUser img').attr('src', mapper.get('image'));
        };
        Metamaps.Mapper.get(synapse.get('user_id'), setMapperImage);
    },

    add_perms_form: function (synapse) {
        //permissions - if owner, also allow permission editing
        $('#editSynLowerBar').append('<div class="mapPerm ' + synapse.get("permission").substring(0, 2) + '"></div>');

        // ability to change permission
        var selectingPermission = false;
        var permissionLiClick = function (event) {
            selectingPermission = false;
            var permission = $(this).attr('class');
            synapse.save({
                permission: permission
            });
            $('#edit_synapse .mapPerm').removeClass('co pu pr minimize').addClass(permission.substring(0, 2));
            $('#edit_synapse .permissionSelect').remove();
            event.stopPropagation();
        };

        var openPermissionSelect = function (event) {
            if (!selectingPermission) {
                selectingPermission = true;
                $(this).addClass('minimize'); // this line flips the drop down arrow to a pull up arrow
                if ($(this).hasClass('co')) {
                    $(this).append('<ul class="permissionSelect"><li class="public"></li><li class="private"></li></ul>');
                } else if ($(this).hasClass('pu')) {
                    $(this).append('<ul class="permissionSelect"><li class="commons"></li><li class="private"></li></ul>');
                } else if ($(this).hasClass('pr')) {
                    $(this).append('<ul class="permissionSelect"><li class="commons"></li><li class="public"></li></ul>');
                }
                $('#edit_synapse .permissionSelect li').click(permissionLiClick);
                event.stopPropagation();
            }
        };

        var hidePermissionSelect = function () {
            selectingPermission = false;
            $('#edit_synapse.yourEdge .mapPerm').removeClass('minimize'); // this line flips the pull up arrow to a drop down arrow
            $('#edit_synapse .permissionSelect').remove();
        };

        if (synapse.authorizePermissionChange(Metamaps.Active.Mapper)) {
            $('#edit_synapse.yourEdge .mapPerm').click(openPermissionSelect);
            $('#edit_synapse').click(hidePermissionSelect);
        }
    }, //add_perms_form

    add_direction_form: function (synapse) {
        //directionality checkboxes
        $('#editSynLowerBar').append('<div id="edit_synapse_left"></div>');
        $('#editSynLowerBar').append('<div id="edit_synapse_right"></div>');

        var edge = synapse.get('edge');

        //determine which node is to the left and the right
        //if directly in a line, top is left
        if (edge.nodeFrom.pos.x < edge.nodeTo.pos.x ||
            edge.nodeFrom.pos.x == edge.nodeTo.pos.x &&
            edge.nodeFrom.pos.y < edge.nodeTo.pos.y) {
            var left = edge.nodeTo.getData("topic");
            var right = edge.nodeFrom.getData("topic");
        } else {
            var left = edge.nodeFrom.getData("topic");
            var right = edge.nodeTo.getData("topic");
        }

        /*
         * One node is actually on the left onscreen. Call it left, & the other right.
         * If category is from-to, and that node is first, check the 'right' checkbox.
         * Else check the 'left' checkbox since the arrow is incoming.
         */

        var directionCat = synapse.get('category'); //both, none, from-to
        if (directionCat == 'from-to') {
            var from_to = [synapse.get("node1_id"), synapse.get("node2_id")];
            if (from_to[0] == left.id) {
                //check left checkbox
                $('#edit_synapse_left').addClass('checked');
            } else {
                //check right checkbox
                $('#edit_synapse_right').addClass('checked');
            }
        } else if (directionCat == 'both') {
            //check both checkboxes
            $('#edit_synapse_left').addClass('checked');
            $('#edit_synapse_right').addClass('checked');
        }

        if (synapse.authorizeToEdit(Metamaps.Active.Mapper)) {
            $('#edit_synapse_left, #edit_synapse_right').click(function () {
                
                $(this).toggleClass('checked');

                var leftChecked = $('#edit_synapse_left').is('.checked');
                var rightChecked = $('#edit_synapse_right').is('.checked');

                var dir = synapse.getDirection();
                var dirCat = 'none';
                if (leftChecked && rightChecked) {
                    dirCat = 'both';
                } else if (!leftChecked && rightChecked) {
                    dirCat = 'from-to';
                    dir = [right.id, left.id];
                } else if (leftChecked && !rightChecked) {
                    dirCat = 'from-to';
                    dir = [left.id, right.id];
                }

                synapse.save({
                    category: dirCat,
                    node1_id: dir[0],
                    node2_id: dir[1]
                });
                Metamaps.Visualize.mGraph.plot();
            });
        } // if
    } //add_direction_form
}; // end Metamaps.SynapseCard


////////////////////// END TOPIC AND SYNAPSE CARDS //////////////////////////////////




/*
 *
 *   VISUALIZE
 *
 */
Metamaps.Visualize = {
    mGraph: null, // a reference to the graph object.
    cameraPosition: null, // stores the camera position when using a 3D visualization
    type: "ForceDirected", // the type of graph we're building, could be "RGraph", "ForceDirected", or "ForceDirected3D"
    loadLater: false, // indicates whether there is JSON that should be loaded right in the offset, or whether to wait till the first topic is created
    init: function () {
        var self = Metamaps.Visualize;
        // disable awkward dragging of the canvas element that would sometimes happen
        $('#infovis-canvas').on('dragstart', function (event) {
            event.preventDefault();
        });

        // prevent touch events on the canvas from default behaviour
        $("#infovis-canvas").bind('touchstart', function (event) {
            event.preventDefault();
            self.mGraph.events.touched = true;
        });

        // prevent touch events on the canvas from default behaviour
        $("#infovis-canvas").bind('touchmove', function (event) {
            //Metamaps.JIT.touchPanZoomHandler(event);
        });

        // prevent touch events on the canvas from default behaviour
        $("#infovis-canvas").bind('touchend touchcancel', function (event) {
            lastDist = 0;
            if (!self.mGraph.events.touchMoved && !Metamaps.Touch.touchDragNode) Metamaps.TopicCard.hideCurrentCard();
            self.mGraph.events.touched = self.mGraph.events.touchMoved = false;
            Metamaps.Touch.touchDragNode = false;
        });
    },
    computePositions: function () {
        var self = Metamaps.Visualize,
            mapping;

        if (self.type == "RGraph") {
            var i, l, startPos, endPos, topic, synapse;

            self.mGraph.graph.eachNode(function (n) {
                topic = Metamaps.Topics.get(n.id);
                topic.set({ node: n }, { silent: true });
                topic.updateNode();

                n.eachAdjacency(function (edge) {
                    if(!edge.getData('init')) {
                        edge.setData('init', true);

                        l = edge.getData('synapseIDs').length;
                        for (i = 0; i < l; i++) {
                            synapse = Metamaps.Synapses.get(edge.getData('synapseIDs')[i]);
                            synapse.set({ edge: edge }, { silent: true });
                            synapse.updateEdge();
                        }
                    }
                });
                
                var pos = n.getPos();
                pos.setc(-200, -200);
            });
            self.mGraph.compute('end');
        } else if (self.type == "ForceDirected") {
            var i, l, startPos, endPos, topic, synapse;

            self.mGraph.graph.eachNode(function (n) {
                topic = Metamaps.Topics.get(n.id);
                topic.set({ node: n }, { silent: true });
                topic.updateNode();
                mapping = topic.getMapping();

                n.eachAdjacency(function (edge) {
                    if(!edge.getData('init')) {
                        edge.setData('init', true);

                        l = edge.getData('synapseIDs').length;
                        for (i = 0; i < l; i++) {
                            synapse = Metamaps.Synapses.get(edge.getData('synapseIDs')[i]);
                            synapse.set({ edge: edge }, { silent: true });
                            synapse.updateEdge();
                        }
                    }
                });

                startPos = new $jit.Complex(0, 0);
                endPos = new $jit.Complex(mapping.get('xloc'), mapping.get('yloc'));
                n.setPos(startPos, 'start');
                n.setPos(endPos, 'end');
            });
        } else if (self.type == "ForceDirected3D") {
            self.mGraph.compute();
        }
    },
    /**
     * render does the heavy lifting of creating the engine that renders the graph with the properties we desire
     *
     */
    render: function () {
        var self = Metamaps.Visualize, RGraphSettings, FDSettings;

        if (self.type == "RGraph" && (!self.mGraph || self.mGraph instanceof $jit.ForceDirected)) {

            RGraphSettings = $.extend(true, {}, Metamaps.JIT.ForceDirected.graphSettings);

            $jit.RGraph.Plot.NodeTypes.implement(Metamaps.JIT.ForceDirected.nodeSettings);
            $jit.RGraph.Plot.EdgeTypes.implement(Metamaps.JIT.ForceDirected.edgeSettings);
            
            RGraphSettings.width = $(document).width();
            RGraphSettings.height = $(document).height();
            RGraphSettings.background = Metamaps.JIT.RGraph.background;
            RGraphSettings.levelDistance = Metamaps.JIT.RGraph.levelDistance;
            
            self.mGraph = new $jit.RGraph(RGraphSettings);

        } else if (self.type == "ForceDirected" && (!self.mGraph || self.mGraph instanceof $jit.RGraph)) {

            FDSettings = $.extend(true, {}, Metamaps.JIT.ForceDirected.graphSettings);

            $jit.ForceDirected.Plot.NodeTypes.implement(Metamaps.JIT.ForceDirected.nodeSettings);
            $jit.ForceDirected.Plot.EdgeTypes.implement(Metamaps.JIT.ForceDirected.edgeSettings);
            
            FDSettings.width = $('body').width();
            FDSettings.height = $('body').height();

            self.mGraph = new $jit.ForceDirected(FDSettings);

        } else if (self.type == "ForceDirected3D" && !self.mGraph) {
            // init ForceDirected3D
            self.mGraph = new $jit.ForceDirected3D(Metamaps.JIT.ForceDirected3D.graphSettings);
            self.cameraPosition = self.mGraph.canvas.canvases[0].camera.position;
        }
        else {
            self.mGraph.graph.empty();
        }

        function runAnimation() {
            Metamaps.Loading.hide();
            // load JSON data, if it's not empty
            if (!self.loadLater) {
                //load JSON data.
                var rootIndex = 0;
                if (Metamaps.Active.Topic) {
                    var node = _.find(Metamaps.JIT.vizData, function(node){
                        return node.id === Metamaps.Active.Topic.id;
                    });
                    rootIndex = _.indexOf(Metamaps.JIT.vizData, node);
                }
                self.mGraph.loadJSON(Metamaps.JIT.vizData, rootIndex);
                //compute positions and plot.
                self.computePositions();
                self.mGraph.busy = true;
                if (self.type == "RGraph") {
                    self.mGraph.fx.animate(Metamaps.JIT.RGraph.animate);
                } else if (self.type == "ForceDirected") {
                    self.mGraph.animate(Metamaps.JIT.ForceDirected.animateSavedLayout);
                } else if (self.type == "ForceDirected3D") {
                    self.mGraph.animate(Metamaps.JIT.ForceDirected.animateFDLayout);
                }
            }
        }
        // hold until all the needed metacode images are loaded
        // hold for a maximum of 80 passes, or 4 seconds of waiting time
        var tries = 0;
        function hold() {
            var unique = _.uniq(Metamaps.Topics.models, function (metacode) { return metacode.get('metacode_id'); }),
                requiredMetacodes = _.map(unique, function (metacode) { return metacode.get('metacode_id'); }),
                loadedCount = 0;

            _.each(requiredMetacodes, function (metacode_id) {
                var metacode = Metamaps.Metacodes.get(metacode_id),
                    img = metacode ? metacode.get('image') : false;

                if (img && (img.complete || (typeof img.naturalWidth !== "undefined" && img.naturalWidth !== 0))) {
                    loadedCount += 1;
                }
            });

            if (loadedCount === requiredMetacodes.length || tries > 80) runAnimation();
            else setTimeout(function(){ tries++; hold() }, 50);
        }
        hold();

        // update the url now that the map is ready
        clearTimeout(Metamaps.routerTimeoutId);
        Metamaps.routerTimeoutId = setTimeout(function(){
            var m = Metamaps.Active.Map;
            var t = Metamaps.Active.Topic;

            if (m && window.location.pathname !== "/maps/" + m.id) {
                Metamaps.Router.navigate("/maps/" + m.id);
            }
            else if (t && window.location.pathname !== "/topics/" + t.id) {
                Metamaps.Router.navigate("/topics/" + t.id);
            }
        }, 800);

    }
}; // end Metamaps.Visualize


/*
 *
 *   UTIL
 *
 */
Metamaps.Util = {
    // helper function to determine how many lines are needed
    // Line Splitter Function
    // copyright Stephen Chapman, 19th April 2006
    // you may copy this code but please keep the copyright notice as well
    splitLine: function (st, n) {
        var b = '';
        var s = st ? st : '';
        while (s.length > n) {
            var c = s.substring(0, n);
            var d = c.lastIndexOf(' ');
            var e = c.lastIndexOf('\n');
            if (e != -1) d = e;
            if (d == -1) d = n;
            b += c.substring(0, d) + '\n';
            s = s.substring(d + 1);
        }
        return b + s;
    },
    nowDateFormatted: function () {
        var date = new Date(Date.now());
        var month = (date.getMonth() + 1) < 10 ? '0' + (date.getMonth() + 1) : (date.getMonth() + 1);
        var day = date.getDate() < 10 ? '0' + date.getDate() : date.getDate();
        var year = date.getFullYear();

        return month + '/' + day + '/' + year;
    },
    decodeEntities: function (desc) {
        var str, temp = document.createElement('p');
        temp.innerHTML = desc; //browser handles the topics
        str = temp.textContent || temp.innerText;
        temp = null; //delete the element;
        return str;
    }, //decodeEntities
    getDistance: function (p1, p2) {
        return Math.sqrt(Math.pow((p2.x - p1.x), 2) + Math.pow((p2.y - p1.y), 2));
    },
    coordsToPixels: function (coords) {
        if (Metamaps.Visualize.mGraph) {
            var canvas = Metamaps.Visualize.mGraph.canvas,
                s = canvas.getSize(),
                p = canvas.getPos(),
                ox = canvas.translateOffsetX,
                oy = canvas.translateOffsetY,
                sx = canvas.scaleOffsetX,
                sy = canvas.scaleOffsetY;
            var pixels = {
              x: (coords.x / (1/sx)) + p.x + s.width/2 + ox,
              y: (coords.y / (1/sy)) + p.y + s.height/2 + oy
            };
            return pixels;
        }
        else {
            return {
                x: 0,
                y: 0
            };
        }
    },
    pixelsToCoords: function (pixels) {
        var coords;
        if (Metamaps.Visualize.mGraph) {
            var canvas = Metamaps.Visualize.mGraph.canvas,
                s = canvas.getSize(),
                p = canvas.getPos(),
                ox = canvas.translateOffsetX,
                oy = canvas.translateOffsetY,
                sx = canvas.scaleOffsetX,
                sy = canvas.scaleOffsetY;
            coords = {
                x: (pixels.x - p.x - s.width/2 - ox) * (1/sx),
                y: (pixels.y - p.y - s.height/2 - oy) * (1/sy),
            };
        }
        else {
            coords = {
                x: 0,
                y: 0
            };
        }
        return coords;
    },
    getPastelColor: function () {
        var r = (Math.round(Math.random()* 127) + 127).toString(16);
        var g = (Math.round(Math.random()* 127) + 127).toString(16);
        var b = (Math.round(Math.random()* 127) + 127).toString(16);
        return Metamaps.Util.colorLuminance('#' + r + g + b, -0.4);
    },
    // darkens a hex value by 'lum' percentage
    colorLuminance: function (hex, lum) {

        // validate hex string
        hex = String(hex).replace(/[^0-9a-f]/gi, '');
        if (hex.length < 6) {
            hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
        }
        lum = lum || 0;

        // convert to decimal and change luminosity
        var rgb = "#", c, i;
        for (i = 0; i < 3; i++) {
            c = parseInt(hex.substr(i*2,2), 16);
            c = Math.round(Math.min(Math.max(0, c + (c * lum)), 255)).toString(16);
            rgb += ("00"+c).substr(c.length);
        }

        return rgb;
    },
    generateOptionsList: function (data) {
        var newlist = "";
        for (var i = 0; i < data.length; i++) {
            newlist = newlist + '<option value="' + data[i]['id'] + '">' + data[i]['1'][1] + '</option>';
        }
        return newlist;
    },
    checkURLisImage: function (url) {
        // when the page reloads the following regular expression will be screwed up
        // please replace it with this one before you save: /*backslashhere*.(jpeg|jpg|gif|png)$/ 
        return (url.match(/\.(jpeg|jpg|gif|png)$/) != null);
    },
    checkURLisYoutubeVideo: function (url) {
        return (url.match(/^http:\/\/(?:www\.)?youtube.com\/watch\?(?=[^?]*v=\w+)(?:[^\s?]+)?$/) != null);
    }
}; // end Metamaps.Util

/*
 *
 *   REALTIME
 *
 */
Metamaps.Realtime = {
    stringForLocalhost: 'http://localhost:5001',
    stringForMetamaps: 'http://metamaps.cc:5001',
    stringForHeroku: 'http://gentle-savannah-1303.herokuapp.com',
    socket: null,
    isOpen: false,
    changing: false,
    mappersOnMap: {},
    status: true, // stores whether realtime is True/On or False/Off
    init: function () {
        var self = Metamaps.Realtime;

        var reenableRealtime = function () {
            self.reenableRealtime();
        };
        var turnOff = function () {
            self.turnOff();
        };
        $(".rtOn").click(reenableRealtime);
        $(".rtOff").click(turnOff);

        $('.sidebarCollaborateIcon').click(self.toggleBox);
        $('.sidebarCollaborateBox').click(function(event){ 
            event.stopPropagation();
        });
        $('body').click(self.close);

        var railsEnv = $('body').data('env');
        var whichToConnect = railsEnv === 'development' ? self.stringForLocalhost : self.stringForMetamaps;
        self.socket = io.connect(whichToConnect);
        self.socket.on('connect', function () {
            self.startActiveMap();
        });
    },
    toggleBox: function (event) {
        var self = Metamaps.Realtime;

        if (self.isOpen) self.close();
        else self.open();

        event.stopPropagation();
    },
    open: function () {
        var self = Metamaps.Realtime;

        Metamaps.GlobalUI.Account.close();
        Metamaps.Filter.close();
        $('.sidebarCollaborateIcon div').addClass('hide');

        if (!self.isOpen && !self.changing) {
            self.changing = true;
            $('.sidebarCollaborateBox').fadeIn(200, function () {
                self.changing = false;
                self.isOpen = true;
            });
        }
    },
    close: function () {
        var self = Metamaps.Realtime;
        $(".sidebarCollaborateIcon div").removeClass('hide');
        if (!self.changing) {
            self.changing = true;
            $('.sidebarCollaborateBox').fadeOut(200, function () {
                self.changing = false;
                self.isOpen = false;
            });
        }
    },
    startActiveMap: function () {
        var self = Metamaps.Realtime;

        if (Metamaps.Active.Map && Metamaps.Active.Mapper) {
            var commonsMap = Metamaps.Active.Map.get('permission') === 'commons';
            var publicMap = Metamaps.Active.Map.get('permission') === 'public';

            if (commonsMap) {
                self.turnOn();
                self.setupSocket();
            }
            else if (publicMap) {
                self.attachMapListener();
            }
        }
    },
    endActiveMap: function () {
        var self = Metamaps.Realtime;

        $(document).off('mousemove');
        self.socket.removeAllListeners();
        self.socket.emit('endMapperNotify');
        $(".collabCompass").remove();
        self.status = false;
    },
    reenableRealtime: function() {
        var confirmString = "The layout of your map has fallen out of sync with the saved copy. ";
        confirmString += "To save your changes without overwriting the map, hit 'Cancel' and ";
        confirmString += "then use 'Save to new map'. ";
        confirmString += "Do you want to discard your changes and enable realtime?";
        var c = confirm(confirmString);
        if (c) {
            Metamaps.Router.maps(Metamaps.Active.Map.id);
        }
    },
    turnOn: function (notify) {
        var self = Metamaps.Realtime;

        if (notify) self.sendRealtimeOn();
        $(".rtMapperSelf").removeClass('littleRtOff').addClass('littleRtOn');
        $('.rtOn').addClass('active');
        $('.rtOff').removeClass('active');
        self.status = true;
        $(".sidebarCollaborateIcon").addClass("blue");
        $(".collabCompass").show();
    },
    turnOff: function (silent) {
        var self = Metamaps.Realtime;

        if (self.status) {
            if (!silent) self.sendRealtimeOff();
            $(".rtMapperSelf").removeClass('littleRtOn').addClass('littleRtOff');
            $('.rtOn').removeClass('active');
            $('.rtOff').addClass('active');
            self.status = false;
            $(".sidebarCollaborateIcon").removeClass("blue");
            $(".collabCompass").hide();
        }
    },
    setupSocket: function () {
        var self = Metamaps.Realtime;
        var socket = Metamaps.Realtime.socket;
        var myId = Metamaps.Active.Mapper.id;
        
        socket.emit('newMapperNotify', {
            userid: myId,
            username: Metamaps.Active.Mapper.get("name"),
            userimage: Metamaps.Active.Mapper.get("image"),
            mapid: Metamaps.Active.Map.id
        });

        // if you're the 'new guy' update your list with who's already online
        socket.on(myId + '-' + Metamaps.Active.Map.id + '-UpdateMapperList', self.updateMapperList);

        // receive word that there's a new mapper on the map
        socket.on('maps-' + Metamaps.Active.Map.id + '-newmapper', self.newPeerOnMap);

        // receive word that a mapper left the map
        socket.on('maps-' + Metamaps.Active.Map.id + '-lostmapper', self.lostPeerOnMap);

        // receive word that there's a mapper turned on realtime
        socket.on('maps-' + Metamaps.Active.Map.id + '-newrealtime', self.newCollaborator);

        // receive word that there's a mapper turned on realtime
        socket.on('maps-' + Metamaps.Active.Map.id + '-lostrealtime', self.lostCollaborator);

        //
        socket.on('maps-' + Metamaps.Active.Map.id + '-topicDrag', self.topicDrag);

        //
        socket.on('maps-' + Metamaps.Active.Map.id + '-newTopic', self.newTopic);

        //
        socket.on('maps-' + Metamaps.Active.Map.id + '-removeTopic', self.removeTopic);

        //
        socket.on('maps-' + Metamaps.Active.Map.id + '-newSynapse', self.newSynapse);

        //
        socket.on('maps-' + Metamaps.Active.Map.id + '-removeSynapse', self.removeSynapse);

        // update mapper compass position
        socket.on('maps-' + Metamaps.Active.Map.id + '-updatePeerCoords', self.updatePeerCoords);

        // deletions
        socket.on('deleteTopicFromServer', self.removeTopic);
        socket.on('deleteSynapseFromServer', self.removeSynapse);

        socket.on('topicChangeFromServer', self.topicChange);
        socket.on('synapseChangeFromServer', self.synapseChange);
        self.attachMapListener();
    
        // local event listeners that trigger events
        var sendCoords = function (event) {
            var pixels = {
                x: event.pageX,
                y: event.pageY
            };
            var coords = Metamaps.Util.pixelsToCoords(pixels);
            self.sendCoords(coords);
        };
        $(document).mousemove(sendCoords);

        var zoom = function (event, e) {
            if (e) {
                var pixels = {
                    x: e.pageX,
                    y: e.pageY
                };
                var coords = Metamaps.Util.pixelsToCoords(pixels);
                self.sendCoords(coords);
            }
            self.positionPeerIcons();
        };
        $(document).on(Metamaps.JIT.events.zoom, zoom);

        $(document).on(Metamaps.JIT.events.pan, self.positionPeerIcons);

        var sendTopicDrag = function (event, positions) {
            self.sendTopicDrag(positions);
        };
        $(document).on(Metamaps.JIT.events.topicDrag, sendTopicDrag);

        var sendNewTopic = function (event, data) {
            self.sendNewTopic(data);
        };
        $(document).on(Metamaps.JIT.events.newTopic, sendNewTopic);

        var sendDeleteTopic = function (event, data) {
            self.sendDeleteTopic(data);
        };
        $(document).on(Metamaps.JIT.events.deleteTopic, sendDeleteTopic);

        var sendRemoveTopic = function (event, data) {
            self.sendRemoveTopic(data);
        };
        $(document).on(Metamaps.JIT.events.removeTopic, sendRemoveTopic);

        var sendNewSynapse = function (event, data) {
            self.sendNewSynapse(data);
        };
        $(document).on(Metamaps.JIT.events.newSynapse, sendNewSynapse);

        var sendDeleteSynapse = function (event, data) {
            self.sendDeleteSynapse(data);
        };
        $(document).on(Metamaps.JIT.events.deleteSynapse, sendDeleteSynapse);

        var sendRemoveSynapse = function (event, data) {
            self.sendRemoveSynapse(data);
        };
        $(document).on(Metamaps.JIT.events.removeSynapse, sendRemoveSynapse);

    },
    attachMapListener: function(){
        var self = Metamaps.Realtime;
        var socket = Metamaps.Realtime.socket;

        socket.on('mapChangeFromServer', self.mapChange);
    },
    sendRealtimeOn: function () {
        var self = Metamaps.Realtime;
        var socket = Metamaps.Realtime.socket;

        // send this new mapper back your details, and the awareness that you're online
        var update = {
            username: Metamaps.Active.Mapper.get("name"),
            userid: Metamaps.Active.Mapper.id,
            mapid: Metamaps.Active.Map.id
        };
        socket.emit('notifyStartRealtime', update);
    },
    sendRealtimeOff: function () {
        var self = Metamaps.Realtime;
        var socket = Metamaps.Realtime.socket;

        // send this new mapper back your details, and the awareness that you're online
        var update = {
            username: Metamaps.Active.Mapper.get("name"),
            userid: Metamaps.Active.Mapper.id,
            mapid: Metamaps.Active.Map.id
        };
        socket.emit('notifyStopRealtime', update);
    },
    updateMapperList: function (data) {
        var self = Metamaps.Realtime;
        var socket = Metamaps.Realtime.socket;

        // data.userid
        // data.username
        // data.userimage
        // data.userrealtime

        self.mappersOnMap[data.userid] = {
            name: data.username,
            image: data.userimage,
            color: Metamaps.Util.getPastelColor(),
            realtime: data.userrealtime,
            coords: {
                x: 0, 
                y: 0
            },
        };

        var onOff = data.userrealtime ? "On" : "Off";
        var mapperListItem = '<li id="mapper';
        mapperListItem += data.userid;
        mapperListItem += '" class="rtMapper littleRt';
        mapperListItem += onOff;
        mapperListItem += '">';
        mapperListItem += '<img style="border: 2px solid ' + self.mappersOnMap[data.userid].color + ';"';
        mapperListItem += ' src="' + data.userimage + '" width="24" height="24" class="rtUserImage" />';
        mapperListItem += data.username;
        mapperListItem += '<div class="littleJuntoIcon"></div>';
        mapperListItem += '</li>';

        if (data.userid !== Metamaps.Active.Mapper.id) {
            $('#mapper' + data.userid).remove();
            $('.realtimeMapperList ul').append(mapperListItem);

            // create a div for the collaborators compass
            self.createCompass(data.username, data.userid, data.userimage, self.mappersOnMap[data.userid].color, !self.status);
        }
    },
    newPeerOnMap: function (data) {
        var self = Metamaps.Realtime;
        var socket = Metamaps.Realtime.socket;

        // data.userid
        // data.username
        // data.userimage
        // data.coords

        self.mappersOnMap[data.userid] = {
            name: data.username,
            image: data.userimage,
            color: Metamaps.Util.getPastelColor(),
            realtime: true,
            coords: {
                x: 0, 
                y: 0
            },
        };

        // create an item for them in the realtime box
        if (data.userid !== Metamaps.Active.Mapper.id && self.status) {
            var mapperListItem = '<li id="mapper' + data.userid + '" class="rtMapper littleRtOn">';
            mapperListItem += '<img style="border: 2px solid ' + self.mappersOnMap[data.userid].color + ';"';
            mapperListItem += ' src="' + data.userimage + '" width="24" height="24" class="rtUserImage" />';
            mapperListItem += data.username;
            mapperListItem += '<div class="littleJuntoIcon"></div>';
            mapperListItem += '</li>';
            $('#mapper' + data.userid).remove();
            $('.realtimeMapperList ul').append(mapperListItem);

            // create a div for the collaborators compass
            self.createCompass(data.username, data.userid, data.userimage, self.mappersOnMap[data.userid].color, !self.status);
            
            Metamaps.GlobalUI.notifyUser(data.username + ' just joined the map');

            // send this new mapper back your details, and the awareness that you've loaded the map
            var update = {
                userToNotify: data.userid,
                username: Metamaps.Active.Mapper.get("name"),
                userimage: Metamaps.Active.Mapper.get("image"),
                userid: Metamaps.Active.Mapper.id,
                userrealtime: self.status,
                mapid: Metamaps.Active.Map.id
            };
            socket.emit('updateNewMapperList', update);
        }
    },
    createCompass: function(name, id, image, color, hide) {
        var str =  '<img width="28" height="28" src="'+image+'" /><p>'+name+'</p>';
        str += '<div id="compassArrow'+id+'" class="compassArrow"></div>';
        $('#compass' + id).remove();
        $('<div/>', {
            id: 'compass' + id,
            class: 'collabCompass'
        }).html(str).appendTo('#wrapper');
        if (hide) {
            $('#compass' + id).hide();
        }
        $('#compass' + id + ' img').css({
            'border': '2px solid ' + color
        });
        $('#compass' + id + ' p').css({
            'background-color': color
        });
    },
    lostPeerOnMap: function (data) {
        var self = Metamaps.Realtime;
        var socket = Metamaps.Realtime.socket;

        // data.userid
        // data.username

        delete self.mappersOnMap[data.userid];

        $('#mapper' + data.userid).remove();
        $('#compass' + data.userid).remove();

        Metamaps.GlobalUI.notifyUser(data.username + ' just left the map');
    },
    newCollaborator: function (data) {
        var self = Metamaps.Realtime;
        var socket = Metamaps.Realtime.socket;

        // data.userid
        // data.username

        self.mappersOnMap[data.userid].realtime = true;

        $('#mapper' + data.userid).removeClass('littleRtOff').addClass('littleRtOn');
        $('#compass' + data.userid).show();

        Metamaps.GlobalUI.notifyUser(data.username + ' just turned on realtime');
    },
    lostCollaborator: function (data) {
        var self = Metamaps.Realtime;
        var socket = Metamaps.Realtime.socket;

        // data.userid
        // data.username

        self.mappersOnMap[data.userid].realtime = false;

        $('#mapper' + data.userid).removeClass('littleRtOn').addClass('littleRtOff');
        $('#compass' + data.userid).hide();

        Metamaps.GlobalUI.notifyUser(data.username + ' just turned off realtime');
    },
    updatePeerCoords: function (data) {
        var self = Metamaps.Realtime;
        var socket = Metamaps.Realtime.socket;

        self.mappersOnMap[data.userid].coords={x: data.usercoords.x,y:data.usercoords.y};
        self.positionPeerIcon(data.userid);
    },
    positionPeerIcons: function () {
        var self = Metamaps.Realtime;
        var socket = Metamaps.Realtime.socket;

        if (self.status) { // if i have realtime turned on
            for (var key in self.mappersOnMap) {
                var mapper = self.mappersOnMap[key];
                if (mapper.realtime) {
                    self.positionPeerIcon(key);
                }
            }
        }
    },
    positionPeerIcon: function (id) {
        var self = Metamaps.Realtime;
        var socket = Metamaps.Realtime.socket;

        var mapper = self.mappersOnMap[id];
        var xMax=$(document).width();
        var yMax=$(document).height();
        var compassDiameter=56;
        var compassArrowSize=24;
        
        var origPixels = Metamaps.Util.coordsToPixels(mapper.coords);
        var pixels = self.limitPixelsToScreen(origPixels);
        $('#compass' + id).css({
            left: pixels.x + 'px',
            top: pixels.y + 'px'
        });
        /* showing the arrow if the collaborator is off of the viewport screen */
        if (origPixels.x !== pixels.x || origPixels.y !== pixels.y) {

            var dy = origPixels.y - pixels.y; //opposite
            var dx = origPixels.x - pixels.x; // adjacent
            var ratio = dy / dx;
            var angle = Math.atan2(dy, dx);
            
            $('#compassArrow' + id).show().css({
                transform: 'rotate(' + angle + 'rad)',
                "-webkit-transform": 'rotate(' + angle + 'rad)',
            });
            
            if (dx > 0) {
                $('#compass' + id).addClass('labelLeft');
            }
        } else {
            $('#compassArrow' + id).hide();
            $('#compass' + id).removeClass('labelLeft');
        }
    },
    limitPixelsToScreen: function (pixels) {
        var self = Metamaps.Realtime;
        var socket = Metamaps.Realtime.socket;

        var xLimit, yLimit;
        var xMax=$(document).width();
        var yMax=$(document).height();
        var compassDiameter=56;
        var compassArrowSize=24;
        
        xLimit = Math.max(0 + compassArrowSize, pixels.x);
        xLimit = Math.min(xLimit, xMax - compassDiameter);
        yLimit = Math.max(0 + compassArrowSize, pixels.y);
        yLimit = Math.min(yLimit, yMax - compassDiameter);
        
        return {x:xLimit,y:yLimit};
    },
    sendCoords: function (coords) {
        var self = Metamaps.Realtime;
        var socket = Metamaps.Realtime.socket;

        var map = Metamaps.Active.Map;
        var mapper = Metamaps.Active.Mapper;

        if (self.status && map.authorizeToEdit(mapper) && socket) {
            var update = {
                usercoords: coords,
                userid: Metamaps.Active.Mapper.id,
                mapid: Metamaps.Active.Map.id
            };
            socket.emit('updateMapperCoords', update);
        }
    },
    sendTopicDrag: function (positions) {
        var self = Metamaps.Realtime;
        var socket = self.socket;

        if (Metamaps.Active.Map && self.status) {
            positions.mapid = Metamaps.Active.Map.id;
            socket.emit('topicDrag', positions);
        }
    },
    topicDrag: function (positions) {
        var self = Metamaps.Realtime;
        var socket = self.socket;

        var topic;
        var node;

        if (Metamaps.Active.Map && self.status) {
            for (var key in positions) {
                topic = Metamaps.Topics.get(key);
                if (topic) node = topic.get('node');
                if (node) node.pos.setc(positions[key].x, positions[key].y);
            } //for
            Metamaps.Visualize.mGraph.plot();
        }
    },
    sendTopicChange: function (topic) {
        var self = Metamaps.Realtime;
        var socket = self.socket;

        var data = {
            topicId: topic.id
        }

        socket.emit('topicChangeFromClient', data);
    },
    topicChange: function (data) {
        var topic = Metamaps.Topics.get(data.topicId);
        if (topic) {
            var node = topic.get('node');
            topic.fetch({
                success: function (model) {
                    model.set({ node: node });
                    model.trigger('changeByOther');
                }
            });
        }
    },
    sendSynapseChange: function (synapse) {
        var self = Metamaps.Realtime;
        var socket = self.socket;

        var data = {
            synapseId: synapse.id
        }

        socket.emit('synapseChangeFromClient', data);
    },
    synapseChange: function (data) {
        var synapse = Metamaps.Synapses.get(data.synapseId);
        if (synapse) {
            // edge reset necessary because fetch causes model reset
            var edge = synapse.get('edge');
            synapse.fetch({
                success: function (model) {
                    model.set({ edge: edge });
                    model.trigger('changeByOther');
                }
            });
        }
    },
    sendMapChange: function (map) {
        var self = Metamaps.Realtime;
        var socket = self.socket;

        var data = {
            mapId: map.id
        }

        socket.emit('mapChangeFromClient', data);
    },
    mapChange: function (data) {
        var map = Metamaps.Active.Map;
        var isActiveMap = map && data.mapId === map.id;
        if (isActiveMap) {
            var permBefore = map.get('permission');
            var idBefore = map.id;
            map.fetch({
                success: function (model, response) {

                    var idNow = model.id;
                    var permNow = model.get('permission');
                    if (idNow !== idBefore) {
                        Metamaps.Map.leavePrivateMap(); // this means the map has been changed to private
                    }
                    else if (permNow === 'public' && permBefore === 'commons') {
                        Metamaps.Map.commonsToPublic();
                    }
                    else if (permNow === 'commons' && permBefore === 'public') {
                        Metamaps.Map.publicToCommons();
                    }
                    else {
                        model.fetchContained();
                        model.trigger('changeByOther');
                    }
                }
            });
        }
    },
    // newTopic
    sendNewTopic: function (data) {
        var self = Metamaps.Realtime;
        var socket = self.socket;

        if (Metamaps.Active.Map && self.status) {
            data.mapperid = Metamaps.Active.Mapper.id;
            data.mapid = Metamaps.Active.Map.id;
            socket.emit('newTopic', data);
        }
    },
    newTopic: function (data) {
        var topic, mapping, mapper, mapperCallback, cancel;

        var self = Metamaps.Realtime;
        var socket = self.socket;

        if (!self.status) return;

        function test() {
            if (topic && mapping && mapper) {
                Metamaps.Topic.renderTopic(mapping, topic, false, false);
            }
            else if (!cancel) {
                setTimeout(test, 10);
            }
        }

        mapper = Metamaps.Mappers.get(data.mapperid);
        if (mapper === undefined) {
            mapperCallback = function (m) {
                Metamaps.Mappers.add(m);
                mapper = m;
            };
            Metamaps.Mapper.get(data.mapperid, mapperCallback);
        }
        $.ajax({
            url: "/topics/" + data.topicid + ".json",
            success: function (response) {
                Metamaps.Topics.add(response);
                topic = Metamaps.Topics.get(response.id);
            },
            error: function () {
                cancel = true;
            }
        });
        $.ajax({
            url: "/mappings/" + data.mappingid + ".json",
            success: function (response) {
                Metamaps.Mappings.add(response);
                mapping = Metamaps.Mappings.get(response.id);
            },
            error: function () {
                cancel = true;
            }
        });

        test();
    },
    // removeTopic
    sendDeleteTopic: function (data) {
        var self = Metamaps.Realtime;
        var socket = self.socket;

        if (Metamaps.Active.Map) {
            socket.emit('deleteTopicFromClient', data);
        }
    },
    // removeTopic
    sendRemoveTopic: function (data) {
        var self = Metamaps.Realtime;
        var socket = self.socket;

        if (Metamaps.Active.Map) {
            data.mapid = Metamaps.Active.Map.id;
            socket.emit('removeTopic', data);
        }
    },
    removeTopic: function (data) {
        var self = Metamaps.Realtime;
        var socket = self.socket;

        if (!self.status) return;

        var topic = Metamaps.Topics.get(data.topicid);
        if (topic) {
            var node = topic.get('node');
            var mapping = topic.getMapping();
            Metamaps.Control.hideNode(node.id);
            Metamaps.Topics.remove(topic);
            Metamaps.Mappings.remove(mapping);
        }
    },
    // newSynapse
    sendNewSynapse: function (data) {
        var self = Metamaps.Realtime;
        var socket = self.socket;

        if (Metamaps.Active.Map) {
            data.mapperid = Metamaps.Active.Mapper.id;
            data.mapid = Metamaps.Active.Map.id;
            socket.emit('newSynapse', data);
        }
    },
    newSynapse: function (data) {
        var topic1, topic2, node1, node2, synapse, mapping, cancel;

        var self = Metamaps.Realtime;
        var socket = self.socket;

        if (!self.status) return;

        function test() {
            if (synapse && mapping && mapper) {
                topic1 = synapse.getTopic1();
                node1 = topic1.get('node');
                topic2 = synapse.getTopic2();
                node2 = topic2.get('node');

                Metamaps.Synapse.renderSynapse(mapping, synapse, node1, node2, false);
            }
            else if (!cancel) {
                setTimeout(test, 10);
            }
        }

        mapper = Metamaps.Mappers.get(data.mapperid);
        if (mapper === undefined) {
            mapperCallback = function (m) {
                Metamaps.Mappers.add(m);
                mapper = m;
            };
            Metamaps.Mapper.get(data.mapperid, mapperCallback);
        }
        $.ajax({
            url: "/synapses/" + data.synapseid + ".json",
            success: function (response) {
                Metamaps.Synapses.add(response);
                synapse = Metamaps.Synapses.get(response.id);
            },
            error: function () {
                cancel = true;
            }
        });
        $.ajax({
            url: "/mappings/" + data.mappingid + ".json",
            success: function (response) {
                Metamaps.Mappings.add(response);
                mapping = Metamaps.Mappings.get(response.id);
            },
            error: function () {
                cancel = true;
            }
        });
        test();
    },
    // deleteSynapse
    sendDeleteSynapse: function (data) {
        var self = Metamaps.Realtime;
        var socket = self.socket;

        if (Metamaps.Active.Map) {
            data.mapid = Metamaps.Active.Map.id;
            socket.emit('deleteSynapseFromClient', data);
        }
    },
    // removeSynapse
    sendRemoveSynapse: function (data) {
        var self = Metamaps.Realtime;
        var socket = self.socket;

        if (Metamaps.Active.Map) {
            data.mapid = Metamaps.Active.Map.id;
            socket.emit('removeSynapse', data);
        }
    },
    removeSynapse: function (data) {
        var self = Metamaps.Realtime;
        var socket = self.socket;

        if (!self.status) return;

        var synapse = Metamaps.Synapses.get(data.synapseid);
        if (synapse) {
            var edge = synapse.get('edge');
            var mapping = synapse.getMapping();
            if (edge.getData("mappings").length - 1 === 0) {
                Metamaps.Control.hideEdge(edge);
            }
            
            var index = _.indexOf(edge.getData("synapses"), synapse);
            edge.getData("mappings").splice(index, 1);
            edge.getData("synapses").splice(index, 1);
            if (edge.getData("displayIndex")) {
                delete edge.data.$displayIndex;
            }
            Metamaps.Synapses.remove(synapse);
            Metamaps.Mappings.remove(mapping);
        }
    },
}; // end Metamaps.Realtime


/*
 *
 *   CONTROL
 *
 */
Metamaps.Control = {
    init: function () {

    },
    selectNode: function (node,e) {
        var filtered = node.getData('alpha') === 0;

        if (filtered || Metamaps.Selected.Nodes.indexOf(node) != -1) return;
        node.selected = true;
        node.setData('dim', 30, 'current');
        Metamaps.Selected.Nodes.push(node);
    },
    deselectAllNodes: function () {
        var l = Metamaps.Selected.Nodes.length;
        for (var i = l - 1; i >= 0; i -= 1) {
            var node = Metamaps.Selected.Nodes[i];
            Metamaps.Control.deselectNode(node);
        }
        Metamaps.Visualize.mGraph.plot();
    },
    deselectNode: function (node) {
        delete node.selected;
        node.setData('dim', 25, 'current');

        //remove the node
        Metamaps.Selected.Nodes.splice(
            Metamaps.Selected.Nodes.indexOf(node), 1);
    },
    deleteSelected: function () {

        if (!Metamaps.Active.Map) return;
        
        var n = Metamaps.Selected.Nodes.length;
        var e = Metamaps.Selected.Edges.length;
        var ntext = n == 1 ? "1 topic" : n + " topics";
        var etext = e == 1 ? "1 synapse" : e + " synapses";
        var text = "You have " + ntext + " and " + etext + " selected. ";

        var authorized = Metamaps.Active.Map.authorizeToEdit(Metamaps.Active.Mapper);

        if (!authorized) {
            Metamaps.GlobalUI.notifyUser("Cannot edit Public map.");
            return;
        }

        var r = confirm(text + "Are you sure you want to permanently delete them all? This will remove them from all maps they appear on.");
        if (r == true) {
            Metamaps.Control.deleteSelectedEdges();
            Metamaps.Control.deleteSelectedNodes();
        }
    },
    deleteSelectedNodes: function () { // refers to deleting topics permanently

        if (!Metamaps.Active.Map) return;

        var authorized = Metamaps.Active.Map.authorizeToEdit(Metamaps.Active.Mapper);

        if (!authorized) {
            Metamaps.GlobalUI.notifyUser("Cannot edit Public map.");
            return;
        }

        var l = Metamaps.Selected.Nodes.length;
        for (var i = l - 1; i >= 0; i -= 1) {
            var node = Metamaps.Selected.Nodes[i];
            Metamaps.Control.deleteNode(node.id);
        }
    },
    deleteNode: function (nodeid) { // refers to deleting topics permanently
        
        if (!Metamaps.Active.Map) return;

        var authorized = Metamaps.Active.Map.authorizeToEdit(Metamaps.Active.Mapper);

        if (!authorized) {
            Metamaps.GlobalUI.notifyUser("Cannot edit Public map.");
            return;
        }

        var node = Metamaps.Visualize.mGraph.graph.getNode(nodeid);
        var topic = node.getData('topic');
        
        var permToDelete = Metamaps.Active.Mapper.id === topic.get('user_id') || Metamaps.Active.Mapper.get('admin');
        if (permToDelete) {
            var topicid = topic.id;
            var mapping = node.getData('mapping');
            topic.destroy();
            Metamaps.Mappings.remove(mapping);
            $(document).trigger(Metamaps.JIT.events.deleteTopic, [{
                topicid: topicid
            }]);
            Metamaps.Control.hideNode(nodeid);
        } else {
            Metamaps.GlobalUI.notifyUser('Only topics you created can be deleted');
        }
    },
    removeSelectedNodes: function () { // refers to removing topics permanently from a map

        if (!Metamaps.Active.Map) return;

        var l = Metamaps.Selected.Nodes.length,
            i,
            node,
            authorized = Metamaps.Active.Map.authorizeToEdit(Metamaps.Active.Mapper);

        if (!authorized) {
            Metamaps.GlobalUI.notifyUser("Cannot edit Public map.");
            return;
        }

        for (i = l - 1; i >= 0; i -= 1) {
            node = Metamaps.Selected.Nodes[i];
            Metamaps.Control.removeNode(node.id);
        }
    },
    removeNode: function (nodeid) { // refers to removing topics permanently from a map

        if (!Metamaps.Active.Map) return;

        var authorized = Metamaps.Active.Map.authorizeToEdit(Metamaps.Active.Mapper);
        var node = Metamaps.Visualize.mGraph.graph.getNode(nodeid);

        if (!authorized) {
            Metamaps.GlobalUI.notifyUser("Cannot edit Public map.");
            return;
        }

        var topic = node.getData('topic');
        var topicid = topic.id;
        var mapping = node.getData('mapping');
        mapping.destroy();
        Metamaps.Topics.remove(topic);
        $(document).trigger(Metamaps.JIT.events.removeTopic, [{
            topicid: topicid
        }]);
        Metamaps.Control.hideNode(nodeid);
    },
    hideSelectedNodes: function () {
        var l = Metamaps.Selected.Nodes.length,
            i,
            node;

        for (i = l - 1; i >= 0; i -= 1) {
            node = Metamaps.Selected.Nodes[i];
            Metamaps.Control.hideNode(node.id);
        }
    },
    hideNode: function (nodeid) {
        var node = Metamaps.Visualize.mGraph.graph.getNode(nodeid);
        var graph = Metamaps.Visualize.mGraph;

        Metamaps.Control.deselectNode(node);

        node.setData('alpha', 0, 'end');
        node.eachAdjacency(function (adj) {
            adj.setData('alpha', 0, 'end');
        });
        Metamaps.Visualize.mGraph.fx.animate({
            modes: ['node-property:alpha',
            'edge-property:alpha'
        ],
            duration: 500
        });
        setTimeout(function () {
            if (nodeid == Metamaps.Visualize.mGraph.root) { // && Metamaps.Visualize.type === "RGraph"
                var newroot = _.find(graph.graph.nodes, function(n){ return n.id !== nodeid; });
                graph.root = newroot ? newroot.id : null;
            }
            Metamaps.Visualize.mGraph.graph.removeNode(nodeid);
        }, 500);
        Metamaps.Filter.checkMetacodes();
        Metamaps.Filter.checkMappers();
    },
    selectEdge: function (edge) {
        var filtered = edge.getData('alpha') === 0; // don't select if the edge is filtered

        if (filtered || Metamaps.Selected.Edges.indexOf(edge) != -1) return;

        var width = Metamaps.Mouse.edgeHoveringOver === edge ? 4 : 2;
        edge.setDataset('current', {
            showDesc: true,
            lineWidth: width,
            color: Metamaps.Settings.colors.synapses.selected
        });
        Metamaps.Visualize.mGraph.plot();

        Metamaps.Selected.Edges.push(edge);
    },
    deselectAllEdges: function () {
        var l = Metamaps.Selected.Edges.length;
        for (var i = l - 1; i >= 0; i -= 1) {
            var edge = Metamaps.Selected.Edges[i];
            Metamaps.Control.deselectEdge(edge);
        }
        Metamaps.Visualize.mGraph.plot();
    },
    deselectEdge: function (edge) {
        edge.setData('showDesc', false, 'current');
        
        edge.setDataset('current', {
            lineWidth: 2,
            color: Metamaps.Settings.colors.synapses.normal
        });

        if (Metamaps.Mouse.edgeHoveringOver == edge) {
            edge.setDataset('current', {
                showDesc: true,
                lineWidth: 4
            });
        }

        Metamaps.Visualize.mGraph.plot();

        //remove the edge
        Metamaps.Selected.Edges.splice(
            Metamaps.Selected.Edges.indexOf(edge), 1);
    },
    deleteSelectedEdges: function () { // refers to deleting topics permanently
        var edge,
            l = Metamaps.Selected.Edges.length;

        if (!Metamaps.Active.Map) return;

        var authorized = Metamaps.Active.Map.authorizeToEdit(Metamaps.Active.Mapper);

        if (!authorized) {
            Metamaps.GlobalUI.notifyUser("Cannot edit Public map.");
            return;
        }

        for (var i = l - 1; i >= 0; i -= 1) {
            edge = Metamaps.Selected.Edges[i];
            Metamaps.Control.deleteEdge(edge);
        }
    },
    deleteEdge: function (edge) {

        if (!Metamaps.Active.Map) return;

        var authorized = Metamaps.Active.Map.authorizeToEdit(Metamaps.Active.Mapper);

        if (!authorized) {
            Metamaps.GlobalUI.notifyUser("Cannot edit Public map.");
            return;
        }

        var index = edge.getData("displayIndex") ? edge.getData("displayIndex") : 0;

        var synapse = edge.getData("synapses")[index];
        var mapping = edge.getData("mappings")[index];
            
        var permToDelete = Metamaps.Active.Mapper.id === synapse.get('user_id') || Metamaps.Active.Mapper.get('admin');
        if (permToDelete) {
            if (edge.getData("synapses").length - 1 === 0) {
                Metamaps.Control.hideEdge(edge);
            }
        
            var synapseid = synapse.id;
            synapse.destroy();

            // the server will destroy the mapping, we just need to remove it here
            Metamaps.Mappings.remove(mapping);
            edge.getData("mappings").splice(index, 1);
            edge.getData("synapses").splice(index, 1);
            if (edge.getData("displayIndex")) {
                delete edge.data.$displayIndex;
            }
            $(document).trigger(Metamaps.JIT.events.deleteSynapse, [{
                synapseid: synapseid
            }]);
        } else {
            Metamaps.GlobalUI.notifyUser('Only synapses you created can be deleted');
        }
    },
    removeSelectedEdges: function () {
        var l = Metamaps.Selected.Edges.length,
            i,
            edge;

        if (!Metamaps.Active.Map) return;

        var authorized = Metamaps.Active.Map.authorizeToEdit(Metamaps.Active.Mapper);

        if (!authorized) {
            Metamaps.GlobalUI.notifyUser("Cannot edit Public map.");
            return;
        }

        for (i = l - 1; i >= 0; i -= 1) {
            edge = Metamaps.Selected.Edges[i];
            Metamaps.Control.removeEdge(edge);
        }
        Metamaps.Selected.Edges = new Array();
    },
    removeEdge: function (edge) {

        if (!Metamaps.Active.Map) return;

        var authorized = Metamaps.Active.Map.authorizeToEdit(Metamaps.Active.Mapper);

        if (!authorized) {
            Metamaps.GlobalUI.notifyUser("Cannot edit Public map.");
            return;
        }

        if (edge.getData("mappings").length - 1 === 0) {
            Metamaps.Control.hideEdge(edge);
        }

        var index = edge.getData("displayIndex") ? edge.getData("displayIndex") : 0;

        var synapse = edge.getData("synapses")[index];
        var mapping = edge.getData("mappings")[index];
        var synapseid = synapse.id;
        mapping.destroy();

        Metamaps.Synapses.remove(synapse);

        edge.getData("mappings").splice(index, 1);
        edge.getData("synapses").splice(index, 1);
        if (edge.getData("displayIndex")) {
            delete edge.data.$displayIndex;
        }
        $(document).trigger(Metamaps.JIT.events.removeSynapse, [{
            synapseid: synapseid
        }]);
    },
    hideSelectedEdges: function () {
        var edge,
            l = Metamaps.Selected.Edges.length,
            i;
        for (i = l - 1; i >= 0; i -= 1) {
            edge = Metamaps.Selected.Edges[i];
            Metamaps.Control.hideEdge(edge);
        }
        Metamaps.Selected.Edges = new Array();
    },
    hideEdge: function (edge) {
        var from = edge.nodeFrom.id;
        var to = edge.nodeTo.id;
        edge.setData('alpha', 0, 'end');
        Metamaps.Control.deselectEdge(edge);
        Metamaps.Visualize.mGraph.fx.animate({
            modes: ['edge-property:alpha'],
            duration: 500
        });
        setTimeout(function () {
            Metamaps.Visualize.mGraph.graph.removeAdjacence(from, to);
        }, 500);
        Metamaps.Filter.checkSynapses();
        Metamaps.Filter.checkMappers();
    },
    updateSelectedPermissions: function (permission) {

        var edge, synapse, node, topic;

        Metamaps.GlobalUI.notifyUser('Working...');

        // variables to keep track of how many nodes and synapses you had the ability to change the permission of
        var nCount = 0,
            sCount = 0;

        // change the permission of the selected synapses, if logged in user is the original creator
        var l = Metamaps.Selected.Edges.length;
        for (var i = l - 1; i >= 0; i -= 1) {
            edge = Metamaps.Selected.Edges[i];
            synapse = edge.getData('synapses')[0];

            if (synapse.authorizePermissionChange(Metamaps.Active.Mapper)) {
                synapse.save({
                    permission: permission
                });
                sCount++;
            }
        }

        // change the permission of the selected topics, if logged in user is the original creator
        var l = Metamaps.Selected.Nodes.length;
        for (var i = l - 1; i >= 0; i -= 1) {
            node = Metamaps.Selected.Nodes[i];
            topic = node.getData('topic');

            if (topic.authorizePermissionChange(Metamaps.Active.Mapper)) {
                topic.save({
                    permission: permission
                });
                nCount++;
            }
        }

        var nString = nCount == 1 ? (nCount.toString() + ' topic and ') : (nCount.toString() + ' topics and ');
        var sString = sCount == 1 ? (sCount.toString() + ' synapse') : (sCount.toString() + ' synapses');

        var message = nString + sString + ' you created updated to ' + permission;
        Metamaps.GlobalUI.notifyUser(message);
    },
    updateSelectedMetacodes: function (metacode_id) {

        var node, topic;

        Metamaps.GlobalUI.notifyUser('Working...');

        var metacode = Metamaps.Metacodes.get(metacode_id);

        // variables to keep track of how many nodes and synapses you had the ability to change the permission of
        var nCount = 0;

        // change the permission of the selected topics, if logged in user is the original creator
        var l = Metamaps.Selected.Nodes.length;
        for (var i = l - 1; i >= 0; i -= 1) {
            node = Metamaps.Selected.Nodes[i];
            topic = node.getData('topic');

            if (topic.authorizeToEdit(Metamaps.Active.Mapper)) {
                topic.save({
                    'metacode_id': metacode_id
                });
                nCount++;
            }
        }

        var nString = nCount == 1 ? (nCount.toString() + ' topic') : (nCount.toString() + ' topics');

        var message = nString + ' you can edit updated to ' + metacode.get('name');
        Metamaps.GlobalUI.notifyUser(message);
        Metamaps.Visualize.mGraph.plot();
    },
}; // end Metamaps.Control


/*
 *
 *   FILTER
 *
 */
Metamaps.Filter = {
    filters: {
        name: "",
        metacodes: [],
        mappers: [],
        synapses: []
    },
    visible: {
        metacodes: [],
        mappers: [],
        synapses: []
    },
    isOpen: false,
    changing: false,
    init: function () {
        var self = Metamaps.Filter;

        $('.sidebarFilterIcon').click(self.toggleBox);

        $('.sidebarFilterBox .showAllMetacodes').click(self.filterNoMetacodes);
        $('.sidebarFilterBox .showAllSynapses').click(self.filterNoSynapses);
        $('.sidebarFilterBox .showAllMappers').click(self.filterNoMappers);
        $('.sidebarFilterBox .hideAllMetacodes').click(self.filterAllMetacodes);
        $('.sidebarFilterBox .hideAllSynapses').click(self.filterAllSynapses);
        $('.sidebarFilterBox .hideAllMappers').click(self.filterAllMappers);

        self.bindLiClicks();
	    self.getFilterData();
    },
    toggleBox: function (event) {
        var self = Metamaps.Filter;

        if (self.isOpen) self.close();
        else self.open();

        event.stopPropagation();
    },
    open: function () {
        var self = Metamaps.Filter;

        Metamaps.GlobalUI.Account.close();
        Metamaps.Realtime.close();
        $('.sidebarFilterIcon div').addClass('hide');


        if (!self.isOpen && !self.changing) {
            self.changing = true;

            var height = $(document).height() - 108;
            $('.sidebarFilterBox').css('max-height', height + 'px').fadeIn(200, function () {
                self.changing = false;
                self.isOpen = true;
            });
        }
    },
    close: function () {
        var self = Metamaps.Filter;
        $('.sidebarFilterIcon div').removeClass('hide');


        if (!self.changing) {
            self.changing = true;

            $('.sidebarFilterBox').fadeOut(200, function () {
                self.changing = false;
                self.isOpen = false;
            });
        }
    },
    reset: function () {
        var self = Metamaps.Filter;

        self.filters.metacodes = [];
        self.filters.mappers = [];
        self.filters.synapses = [];
        self.visible.metacodes = [];
        self.visible.mappers = [];
        self.visible.synapses = [];

        $('#filter_by_metacode ul').empty(); 
        $('#filter_by_mapper ul').empty();
        $('#filter_by_synapse ul').empty();

        $('.filterBox .showAll').addClass('active');
    },
    /*  
    Most of this data essentially depends on the ruby function which are happening for filter inside view filterBox
    But what these function do is load this data into three accessible array within java : metacodes, mappers and synapses
    */
    getFilterData: function () {
        var self = Metamaps.Filter;

        var metacode, mapper, synapse;

        $('#filter_by_metacode li').each(function() {
            metacode = $( this ).attr('data-id');
            self.filters.metacodes.push(metacode);
            self.visible.metacodes.push(metacode);
        }); 

        $('#filter_by_mapper li').each(function()  {
            mapper = ($( this ).attr('data-id'));
            self.filters.mappers.push(mapper);
            self.visible.mappers.push(mapper);
        });

        $('#filter_by_synapse li').each(function()  {
            synapse = ($( this ).attr('data-id'));  
            self.filters.synapses.push(synapse);
            self.visible.synapses.push(synapse);
        });
    },
    bindLiClicks: function () {
        var self = Metamaps.Filter;
        $('#filter_by_metacode ul li').unbind().click(self.toggleMetacode);
        $('#filter_by_mapper ul li').unbind().click(self.toggleMapper);
        $('#filter_by_synapse ul li').unbind().click(self.toggleSynapse);
    },
    // an abstraction function for checkMetacodes, checkMappers, checkSynapses to reduce
    // code redundancy
    /*
    @param 
    */
    updateFilters: function (collection, propertyToCheck, correlatedModel, filtersToUse, listToModify) {
        var self = Metamaps.Filter;
        
        var newList = [];
        var removed = [];
        var added = [];
        
        // the first option enables us to accept
        // ['Topics', 'Synapses'] as 'collection'
        if (typeof collection === "object") {
            Metamaps[collection[0]].each(function(model) {
                var prop = model.get(propertyToCheck) ? model.get(propertyToCheck).toString() : false;
                if (prop && newList.indexOf(prop) === -1) {
                    newList.push(prop);
                }
            });
            Metamaps[collection[1]].each(function(model) {
                var prop = model.get(propertyToCheck) ? model.get(propertyToCheck).toString() : false;
                if (prop && newList.indexOf(prop) === -1) {
                    newList.push(prop);
                }
            });
        }
        else if (typeof collection === "string") {
            Metamaps[collection].each(function(model) {
                var prop = model.get(propertyToCheck) ? model.get(propertyToCheck).toString() : false;
                if (prop && newList.indexOf(prop) === -1) {
                    newList.push(prop);
                }
            });
        }
        
        removed = _.difference(self.filters[filtersToUse], newList);
        added = _.difference(newList, self.filters[filtersToUse]);
        
        // remove the list items for things no longer present on the map
        _.each(removed, function(identifier) {
            $('#filter_by_' + listToModify + ' li[data-id="' + identifier + '"]').fadeOut('fast',function(){
                $(this).remove();
            });
            index = self.visible[filtersToUse].indexOf(identifier);
            self.visible[filtersToUse].splice(index, 1);
        });
        
        var model, li, jQueryLi;
        function sortAlpha(a,b){
            return a.childNodes[1].innerHTML.toLowerCase() > b.childNodes[1].innerHTML.toLowerCase() ? 1 : -1;  
        }
        // for each new filter to be added, create a list item for it and fade it in
        _.each(added, function (identifier) {
            model = Metamaps[correlatedModel].get(identifier) || 
                Metamaps[correlatedModel].find(function (model) {
                    return model.get(propertyToCheck) === identifier;
                });
            li = model.prepareLiForFilter();
            jQueryLi = $(li).hide();
            $('li', '#filter_by_' + listToModify + ' ul').add(jQueryLi.fadeIn("fast"))
                .sort(sortAlpha).appendTo('#filter_by_' + listToModify + ' ul');
            self.visible[filtersToUse].push(identifier);
        });

        // update the list of filters with the new list we just generated
        self.filters[filtersToUse] = newList;

        // make sure clicks on list items still trigger the right events
        self.bindLiClicks();
    },
    checkMetacodes: function () {
        var self = Metamaps.Filter;
        self.updateFilters('Topics', 'metacode_id', 'Metacodes', 'metacodes', 'metacode');
    },
    checkMappers: function () {
        var self = Metamaps.Filter;
        var onMap = Metamaps.Active.Map ? true : false;
        if (onMap) {
            self.updateFilters('Mappings', 'user_id', 'Mappers', 'mappers', 'mapper');
        }
        else {
            // on topic view
            self.updateFilters(['Topics', 'Synapses'], 'user_id', 'Creators', 'mappers', 'mapper');
        }
    },
    checkSynapses: function () {
        var self = Metamaps.Filter;
        self.updateFilters('Synapses', 'desc', 'Synapses', 'synapses', 'synapse');
    },
    filterAllMetacodes: function (e) {
        var self = Metamaps.Filter;
        $('#filter_by_metacode ul li').addClass('toggledOff');
        $('.showAllMetacodes').removeClass('active');
        $('.hideAllMetacodes').addClass('active');
        self.visible.metacodes = [];
        self.passFilters();
    },
    filterNoMetacodes: function (e) {
        var self = Metamaps.Filter;
        $('#filter_by_metacode ul li').removeClass('toggledOff');
        $('.showAllMetacodes').addClass('active');
        $('.hideAllMetacodes').removeClass('active');
        self.visible.metacodes = self.filters.metacodes.slice();
        self.passFilters();
    },
    filterAllMappers: function (e) {
        var self = Metamaps.Filter;
        $('#filter_by_mapper ul li').addClass('toggledOff');
        $('.showAllMappers').removeClass('active');
        $('.hideAllMappers').addClass('active');
        self.visible.mappers = [];
        self.passFilters();       
    },
    filterNoMappers: function (e) {
        var self = Metamaps.Filter;
        $('#filter_by_mapper ul li').removeClass('toggledOff');
        $('.showAllMappers').addClass('active');
        $('.hideAllMappers').removeClass('active');
        self.visible.mappers = self.filters.mappers.slice();
        self.passFilters();
    },
    filterAllSynapses: function (e) {
        var self = Metamaps.Filter;
        $('#filter_by_synapse ul li').addClass('toggledOff');
        $('.showAllSynapses').removeClass('active');
        $('.hideAllSynapses').addClass('active');
        self.visible.synapses = [];
        self.passFilters();
    },
    filterNoSynapses: function (e) {
        var self = Metamaps.Filter;
        $('#filter_by_synapse ul li').removeClass('toggledOff');
        $('.showAllSynapses').addClass('active');
        $('.hideAllSynapses').removeClass('active');
        self.visible.synapses = self.filters.synapses.slice();
        self.passFilters();
    },
    // an abstraction function for toggleMetacode, toggleMapper, toggleSynapse
    // to reduce code redundancy
    // gets called in the context of a list item in a filter box
    toggleLi: function (whichToFilter) {
        var self = Metamaps.Filter, index;
        var id = $(this).attr("data-id");
        if (self.visible[whichToFilter].indexOf(id) == -1) {
            self.visible[whichToFilter].push(id);
            $(this).removeClass('toggledOff');
        }
        else {
            index = self.visible[whichToFilter].indexOf(id);
            self.visible[whichToFilter].splice(index, 1);
            $(this).addClass('toggledOff');
        }
        self.passFilters();
    },
    toggleMetacode: function () {
        var self = Metamaps.Filter;
        self.toggleLi.call(this, 'metacodes');

        if (self.visible.metacodes.length === self.filters.metacodes.length) {
            $('.showAllMetacodes').addClass('active');
            $('.hideAllMetacodes').removeClass('active');
        }
        else if (self.visible.metacodes.length === 0) {
            $('.showAllMetacodes').removeClass('active');
            $('.hideAllMetacodes').addClass('active');
        }
        else {
            $('.showAllMetacodes').removeClass('active');
            $('.hideAllMetacodes').removeClass('active');
        }
    },
    toggleMapper: function () {
        var self = Metamaps.Filter;
        self.toggleLi.call(this, 'mappers');

        if (self.visible.mappers.length === self.filters.mappers.length) {
            $('.showAllMappers').addClass('active');
            $('.hideAllMappers').removeClass('active');
        }
        else if (self.visible.mappers.length === 0) {
            $('.showAllMappers').removeClass('active');
            $('.hideAllMappers').addClass('active');
        }
        else {
            $('.showAllMappers').removeClass('active');
            $('.hideAllMappers').removeClass('active');
        }
    },
    toggleSynapse: function () {
        var self = Metamaps.Filter;
        self.toggleLi.call(this, 'synapses');

        if (self.visible.synapses.length === self.filters.synapses.length) {
            $('.showAllSynapses').addClass('active');
            $('.hideAllSynapses').removeClass('active');
        }
        else if (self.visible.synapses.length === 0) {
            $('.showAllSynapses').removeClass('active');
            $('.hideAllSynapses').addClass('active');
        }
        else {
            $('.showAllSynapses').removeClass('active');
            $('.hideAllSynapses').removeClass('active');
        }
    },
    passFilters: function () {        
        var self = Metamaps.Filter;
        var visible = self.visible;

        var passesMetacode, passesMapper, passesSynapse;
        var onMap;

        if (Metamaps.Active.Map) {
            onMap = true;
        }
        else if (Metamaps.Active.Topic) {
            onMap = false;
        }

        var opacityForFilter = onMap ? 0 : 0.4;

        Metamaps.Topics.each(function(topic) {
            var n = topic.get('node');
            var metacode_id = topic.get("metacode_id").toString();

            if (visible.metacodes.indexOf(metacode_id) == -1) passesMetacode = false;
            else passesMetacode = true;

            if (onMap) {
                // when on a map, 
                // we filter by mapper according to the person who added the 
                // topic or synapse to the map
                var user_id = topic.getMapping().get("user_id").toString();
                if (visible.mappers.indexOf(user_id) == -1) passesMapper = false;
                else passesMapper = true;
            }
            else {
                // when on a topic view, 
                // we filter by mapper according to the person who created the 
                // topic or synapse
                var user_id = topic.get("user_id").toString();
                if (visible.mappers.indexOf(user_id) == -1) passesMapper = false;
                else passesMapper = true;
            }

            if (passesMetacode && passesMapper) {
                if (n) {
                    n.setData('alpha', 1, 'end');
                }
                else console.log(topic);
            }
            else {
                if (n) {
                    Metamaps.Control.deselectNode(n, true);
                    n.setData('alpha', opacityForFilter, 'end');
                    n.eachAdjacency(function(e){
                        Metamaps.Control.deselectEdge(e, true);
                    });
                }
                else console.log(topic);
            }
        });

        // flag all the edges back to 'untouched'
        Metamaps.Synapses.each(function(synapse) {
           var e = synapse.get('edge');
           e.setData('touched', false);
        });
        Metamaps.Synapses.each(function(synapse) {
           var e = synapse.get('edge');
           var desc;
           var user_id = synapse.get("user_id").toString();

           if (e && !e.getData('touched')) {

                var synapses = e.getData('synapses');

                // if any of the synapses represent by the edge are still unfiltered
                // leave the edge visible
                passesSynapse = false;
                for (var i = 0; i < synapses.length; i++) {
                    desc = synapses[i].get("desc");
                    if (visible.synapses.indexOf(desc) > -1) passesSynapse = true;
                }

                // if the synapse description being displayed is now being
                // filtered, set the displayIndex to the first unfiltered synapse if there is one
                var displayIndex = e.getData("displayIndex") ? e.getData("displayIndex") : 0;
                var displayedSynapse = synapses[displayIndex];
                desc = displayedSynapse.get("desc");
                if (passesSynapse && visible.synapses.indexOf(desc) == -1) {
                    // iterate and find an unfiltered one
                    for (var i = 0; i < synapses.length; i++) {
                        desc = synapses[i].get("desc");
                        if (visible.synapses.indexOf(desc) > -1) {
                            e.setData('displayIndex', i);
                            break;
                        }
                    }
                }

                if (onMap) {
                    // when on a map, 
                    // we filter by mapper according to the person who added the 
                    // topic or synapse to the map
                    user_id = synapse.getMapping().get("user_id").toString();
                }
                if (visible.mappers.indexOf(user_id) == -1) passesMapper = false;
                else passesMapper = true;

                var color = Metamaps.Settings.colors.synapses.normal;
                if (passesSynapse && passesMapper) {
                    e.setData('alpha', 1, 'end');
                    e.setData('color', color, 'end');
                }
                else {
                    Metamaps.Control.deselectEdge(e, true);
                    e.setData('alpha', opacityForFilter, 'end');
                }

                e.setData('touched', true);
            }
            else if (!e) console.log(synapse);
        });
            
        // run the animation
        Metamaps.Visualize.mGraph.fx.animate({  
          modes: ['node-property:alpha',  
                'edge-property:alpha'],  
          duration: 200  
        });
    }
}; // end Metamaps.Filter


/*
 *
 *   LISTENERS
 *
 */
Metamaps.Listeners = {

    init: function () {

        $(document).on('keydown', function (e) {
            if (!(Metamaps.Active.Map || Metamaps.Active.Topic)) return;

            switch (e.which) {
            case 13: // if enter key is pressed
                Metamaps.JIT.enterKeyHandler();
                e.preventDefault();
                break;
            case 27: // if esc key is pressed
                Metamaps.JIT.escKeyHandler();
                break;
            case 65: //if a or A is pressed
                if (e.ctrlKey){
                    Metamaps.Control.deselectAllNodes();
                    Metamaps.Control.deselectAllEdges();

                    e.preventDefault();
                    Metamaps.Visualize.mGraph.graph.eachNode(function (n) {
                        Metamaps.Control.selectNode(n,e);
                    });

                    Metamaps.Visualize.mGraph.plot();
                }
                
                break;
            case 69: //if e or E is pressed
                if (e.ctrlKey){
                    e.preventDefault();
                    if (Metamaps.Active.Map) {
                        Metamaps.JIT.zoomExtents(null, Metamaps.Visualize.mGraph.canvas);
                    }
                }
                break;
            case 77: //if m or M is pressed
                if (e.ctrlKey){
                    e.preventDefault();
                    Metamaps.Control.removeSelectedNodes();
                    Metamaps.Control.removeSelectedEdges();
                }
                break;
            case 68: //if d or D is pressed
                if (e.ctrlKey){
                    e.preventDefault();
                    Metamaps.Control.deleteSelected();
                }
                break;
            case 72: //if h or H is pressed
                if (e.ctrlKey){
                    e.preventDefault();
                    Metamaps.Control.hideSelectedNodes();
                    Metamaps.Control.hideSelectedEdges();
                }
                break;
            default:
                break; //alert(e.which);
            }
        });

        $(window).resize(function () {
            if (Metamaps.Visualize && Metamaps.Visualize.mGraph) Metamaps.Visualize.mGraph.canvas.resize($(window).width(), $(window).height());
            if ((Metamaps.Active.Map || Metamaps.Active.Topic) && Metamaps.Famous && Metamaps.Famous.maps.surf) Metamaps.Famous.maps.reposition();
        });
    }
}; // end Metamaps.Listeners


/*
 *
 *   ORGANIZE
 *
 */
Metamaps.Organize = {
    init: function () {

    },
    arrange: function (layout, centerNode) {


        // first option for layout to implement is 'grid', will do an evenly spaced grid with its center at the 0,0 origin
        if (layout == 'grid') {
            var numNodes = _.size(Metamaps.Visualize.mGraph.graph.nodes); // this will always be an integer, the # of nodes on your graph visualization
            var numColumns = Math.floor(Math.sqrt(numNodes)); // the number of columns to make an even grid
            var GRIDSPACE = 400;
            var row = 0;
            var column = 0;
            Metamaps.Visualize.mGraph.graph.eachNode(function (n) {
                if (column == numColumns) {
                    column = 0;
                    row += 1;
                }
                var newPos = new $jit.Complex();
                newPos.x = column * GRIDSPACE;
                newPos.y = row * GRIDSPACE;
                n.setPos(newPos, 'end');
                column += 1;
            });
            Metamaps.Visualize.mGraph.animate(Metamaps.JIT.ForceDirected.animateSavedLayout);
        } else if (layout == 'grid_full') {

            // this will always be an integer, the # of nodes on your graph visualization
            var numNodes = _.size(Metamaps.Visualize.mGraph.graph.nodes);
            //var numColumns = Math.floor(Math.sqrt(numNodes)); // the number of columns to make an even grid
            //var GRIDSPACE = 400;
            var height = Metamaps.Visualize.mGraph.canvas.getSize(0).height;
            var width = Metamaps.Visualize.mGraph.canvas.getSize(0).width;
            var totalArea = height * width;
            var cellArea = totalArea / numNodes;
            var ratio = height / width;
            var cellWidth = sqrt(cellArea / ratio);
            var cellHeight = cellArea / cellWidth;
            var row = floor(height / cellHeight);
            var column = floor(width / cellWidth);
            var totalCells = row * column;

            if (totalCells)
                Metamaps.Visualize.mGraph.graph.eachNode(function (n) {
                    if (column == numColumns) {
                        column = 0;
                        row += 1;
                    }
                    var newPos = new $jit.Complex();
                    newPos.x = column * GRIDSPACE;
                    newPos.y = row * GRIDSPACE;
                    n.setPos(newPos, 'end');
                    column += 1;
                });
            Metamaps.Visualize.mGraph.animate(Metamaps.JIT.ForceDirected.animateSavedLayout);
        } else if (layout == 'radial') {

            var centerX = centerNode.getPos().x;
            var centerY = centerNode.getPos().y;
            centerNode.setPos(centerNode.getPos(), 'end');

            console.log(centerNode.adjacencies);
            var lineLength = 200;
            var usedNodes = {};
            usedNodes[centerNode.id] = centerNode;
            var radial = function (node, level, degree) {
                if (level == 1) {
                    var numLinksTemp = _.size(node.adjacencies);
                    var angleTemp = 2 * Math.PI / numLinksTemp;
                } else {
                    angleTemp = 2 * Math.PI / 20
                };
                node.eachAdjacency(function (a) {
                    var isSecondLevelNode = (centerNode.adjacencies[a.nodeTo.id] != undefined && level > 1);
                    if (usedNodes[a.nodeTo.id] == undefined && !isSecondLevelNode) {
                        var newPos = new $jit.Complex();
                        newPos.x = level * lineLength * Math.sin(degree) + centerX;
                        newPos.y = level * lineLength * Math.cos(degree) + centerY;
                        a.nodeTo.setPos(newPos, 'end');
                        usedNodes[a.nodeTo.id] = a.nodeTo;

                        radial(a.nodeTo, level + 1, degree);
                        degree += angleTemp;
                    };
                });
            };
            radial(centerNode, 1, 0);
            Metamaps.Visualize.mGraph.animate(Metamaps.JIT.ForceDirected.animateSavedLayout);

        } else if (layout == 'center_viewport') {

            var lowX = 0,
                lowY = 0,
                highX = 0,
                highY = 0;
            var oldOriginX = Metamaps.Visualize.mGraph.canvas.translateOffsetX;
            var oldOriginY = Metamaps.Visualize.mGraph.canvas.translateOffsetY;

            Metamaps.Visualize.mGraph.graph.eachNode(function (n) {
                if (n.id === 1) {
                    lowX = n.getPos().x;
                    lowY = n.getPos().y;
                    highX = n.getPos().x;
                    highY = n.getPos().y;
                };
                if (n.getPos().x < lowX) lowX = n.getPos().x;
                if (n.getPos().y < lowY) lowY = n.getPos().y;
                if (n.getPos().x > highX) highX = n.getPos().x;
                if (n.getPos().y > highY) highY = n.getPos().y;
            });
            console.log(lowX, lowY, highX, highY);
            var newOriginX = (lowX + highX) / 2;
            var newOriginY = (lowY + highY) / 2;

        } else alert('please call function with a valid layout dammit!');
    }
}; // end Metamaps.Organize


/*
 *
 *   TOPIC
 *
 */
Metamaps.Topic = {
    // this function is to retrieve a topic JSON object from the database
    // @param id = the id of the topic to retrieve
    get: function (id, callback) {
        // if the desired topic is not yet in the local topic repository, fetch it
        if (Metamaps.Topics.get(id) == undefined) {
            //console.log("Ajax call!");
            if (!callback) {
                var e = $.ajax({
                    url: "/topics/" + id + ".json",
                    async: false
                });
                Metamaps.Topics.add($.parseJSON(e.responseText));
                return Metamaps.Topics.get(id);
            } else {
                return $.ajax({
                    url: "/topics/" + id + ".json",
                    success: function (data) {
                        Metamaps.Topics.add(data);
                        callback(Metamaps.Topics.get(id));
                    }
                });
            }
        } else {
            if (!callback) {
                return Metamaps.Topics.get(id);
            } else {
                return callback(Metamaps.Topics.get(id));
            }
        }
    },
    launch: function (id) {
        var bb = Metamaps.Backbone;
        var start = function (data) {
            Metamaps.Active.Topic = new bb.Topic(data.topic);
            Metamaps.Creators = new bb.MapperCollection(data.creators);
            Metamaps.Topics = new bb.TopicCollection([data.topic].concat(data.relatives));
            Metamaps.Synapses = new bb.SynapseCollection(data.synapses);
            Metamaps.Backbone.attachCollectionEvents();

            // set filter mapper H3 text
            $('#filter_by_mapper h3').html('CREATORS');

            // build and render the visualization
            Metamaps.Visualize.type = "RGraph";
            Metamaps.JIT.prepareVizData();

            // update filters
            Metamaps.Filter.reset(); 

            // reset selected arrays
            Metamaps.Selected.reset();

            // these three update the actual filter box with the right list items
            Metamaps.Filter.checkMetacodes();
            Metamaps.Filter.checkSynapses();
            Metamaps.Filter.checkMappers();
        }

        $.ajax({
            url: "/topics/" + id + "/network.json",
            success: start
        });
    },
    end: function () {
        if (Metamaps.Active.Topic) {
            $('.rightclickmenu').remove();
            Metamaps.TopicCard.hideCard();
            Metamaps.SynapseCard.hideCard();
            Metamaps.Filter.close();
        }
    },
    centerOn: function (nodeid) {
        if (!Metamaps.Visualize.mGraph.busy) {
            Metamaps.Visualize.mGraph.onClick(nodeid, {
                hideLabels: false,
                duration: 1000,
                onComplete: function () {
                    
                }
            });
        }
    },
    fetchRelatives: function(node, metacode_id) {
        
        var topics = Metamaps.Topics.map(function(t){ return t.id });
        var topics_string = topics.join();

        var creators = Metamaps.Creators.map(function(t){ return t.id });
        var creators_string = creators.join();

        var topic = node.getData('topic');

        var successCallback = function(data) {
            if (data.creators.length > 0) Metamaps.Creators.add(data.creators);
            if (data.topics.length > 0) Metamaps.Topics.add(data.topics);
            if (data.synapses.length > 0) Metamaps.Synapses.add(data.synapses);

            var topicColl = new Metamaps.Backbone.TopicCollection(data.topics);
            topicColl.add(topic);
            var synapseColl = new Metamaps.Backbone.SynapseCollection(data.synapses);

            var graph = Metamaps.JIT.convertModelsToJIT(topicColl, synapseColl)[0];
            Metamaps.Visualize.mGraph.op.sum(graph, {
                type: 'fade',
                duration: 500,
                hideLabels: false
            });

            var i, l, t, s;
        
            Metamaps.Visualize.mGraph.graph.eachNode(function (n) {
                t = Metamaps.Topics.get(n.id);
                t.set({ node: n }, { silent: true });
                t.updateNode();

                n.eachAdjacency(function (edge) {
                    if(!edge.getData('init')) {
                        edge.setData('init', true);

                        l = edge.getData('synapseIDs').length;
                        for (i = 0; i < l; i++) {
                            s = Metamaps.Synapses.get(edge.getData('synapseIDs')[i]);
                            s.set({ edge: edge }, { silent: true });
                            s.updateEdge();
                        }
                    }
                });
            });
        };

        var paramsString = metacode_id ? "metacode=" + metacode_id + "&" : "";
        paramsString += "network=" + topics_string + "&creators=" + creators_string;

        $.ajax({
            type: "Get",
            url: "/topics/" + topic.id + "/relatives.json?" + paramsString,
            success: successCallback,
            error: function () {
                
            }
        });
    },
    /*
     *
     *
     */
    renderTopic: function (mapping, topic, createNewInDB, permitCreateSynapseAfter) {
        var self = Metamaps.Topic;

        var nodeOnViz, tempPos;

        var newnode = topic.createNode();

        var midpoint = {}, pixelPos;

        if (!$.isEmptyObject(Metamaps.Visualize.mGraph.graph.nodes)) {
            Metamaps.Visualize.mGraph.graph.addNode(newnode);
            nodeOnViz = Metamaps.Visualize.mGraph.graph.getNode(newnode.id);
            topic.set('node', nodeOnViz, {silent: true});  
            topic.updateNode(); // links the topic and the mapping to the node 

            nodeOnViz.setData("dim", 1, "start");
            nodeOnViz.setData("dim", 25, "end");
            if (Metamaps.Visualize.type === "RGraph") {
                tempPos = new $jit.Complex(mapping.get('xloc'), mapping.get('yloc'));
                tempPos = tempPos.toPolar();
                nodeOnViz.setPos(tempPos, "current");
                nodeOnViz.setPos(tempPos, "start");
                nodeOnViz.setPos(tempPos, "end");
            } else if (Metamaps.Visualize.type === "ForceDirected") {
                nodeOnViz.setPos(new $jit.Complex(mapping.get('xloc'), mapping.get('yloc')), "current");
                nodeOnViz.setPos(new $jit.Complex(mapping.get('xloc'), mapping.get('yloc')), "start");
                nodeOnViz.setPos(new $jit.Complex(mapping.get('xloc'), mapping.get('yloc')), "end");
            }
            if (Metamaps.Create.newTopic.addSynapse && permitCreateSynapseAfter) {
                Metamaps.Create.newSynapse.topic1id = tempNode.getData('topic').id;
                
                // position the form
                midpoint.x = tempNode.pos.getc().x + (nodeOnViz.pos.getc().x - tempNode.pos.getc().x) / 2;
                midpoint.y = tempNode.pos.getc().y + (nodeOnViz.pos.getc().y - tempNode.pos.getc().y) / 2;
                pixelPos = Metamaps.Util.coordsToPixels(midpoint);
                $('#new_synapse').css('left', pixelPos.x + "px");
                $('#new_synapse').css('top', pixelPos.y + "px");
                // show the form
                Metamaps.Create.newSynapse.open();
                Metamaps.Visualize.mGraph.fx.animate({
                    modes: ["node-property:dim"],
                    duration: 500,
                    onComplete: function () {
                        tempNode = null;
                        tempNode2 = null;
                        tempInit = false;
                    }
                });
            } else {
                Metamaps.Visualize.mGraph.fx.plotNode(nodeOnViz, Metamaps.Visualize.mGraph.canvas);
                Metamaps.Visualize.mGraph.fx.animate({
                    modes: ["node-property:dim"],
                    duration: 500,
                    onComplete: function () {

                    }
                });
            }
        } else {
            Metamaps.Visualize.mGraph.loadJSON(newnode);
            nodeOnViz = Metamaps.Visualize.mGraph.graph.getNode(newnode.id);
            topic.set('node', nodeOnViz, {silent: true});
            topic.updateNode(); // links the topic and the mapping to the node 

            nodeOnViz.setData("dim", 1, "start");
            nodeOnViz.setData("dim", 25, "end");
            nodeOnViz.setPos(new $jit.Complex(mapping.get('xloc'), mapping.get('yloc')), "current");
            nodeOnViz.setPos(new $jit.Complex(mapping.get('xloc'), mapping.get('yloc')), "start");
            nodeOnViz.setPos(new $jit.Complex(mapping.get('xloc'), mapping.get('yloc')), "end");
            Metamaps.Visualize.mGraph.fx.plotNode(nodeOnViz, Metamaps.Visualize.mGraph.canvas);
            Metamaps.Visualize.mGraph.fx.animate({
                modes: ["node-property:dim"],
                duration: 500,
                onComplete: function () {

                }
            });
        }

        var mappingSuccessCallback = function (mappingModel, response) {
            var newTopicData = {
                mappingid: mappingModel.id,
                topicid: mappingModel.get('topic_id')
            };

            $(document).trigger(Metamaps.JIT.events.newTopic, [newTopicData]);
        };  
        var topicSuccessCallback = function (topicModel, response) {
            if (Metamaps.Active.Map) {
                mapping.save({ topic_id: topicModel.id }, {
                    success: mappingSuccessCallback,
                    error: function (model, response) {
                        console.log('error saving mapping to database');
                    }
                });
            }

            if (Metamaps.Create.newTopic.addSynapse) {
                Metamaps.Create.newSynapse.topic2id = topicModel.id;
            }
        };

        if (!Metamaps.Settings.sandbox && createNewInDB) {
            if (topic.isNew()) {
                topic.save(null, {
                    success: topicSuccessCallback,
                    error: function (model, response) {
                        console.log('error saving topic to database');
                    }
                });
            } else if (!topic.isNew() && Metamaps.Active.Map) {
                mapping.save(null, {
                    success: mappingSuccessCallback
                });
            }
        }
    },
    createTopicLocally: function () {
        var self = Metamaps.Topic;

        if (Metamaps.Create.newTopic.name === "") {
            Metamaps.GlobalUI.notifyUser("Please enter a topic title...");
            return;
        }

        // hide the 'double-click to add a topic' message
        Metamaps.Famous.viz.hideInstructions();

        $(document).trigger(Metamaps.Map.events.editedByActiveMapper);

        var metacode = Metamaps.Metacodes.get(Metamaps.Create.newTopic.metacode);

        var topic = new Metamaps.Backbone.Topic({
            name: Metamaps.Create.newTopic.name,
            metacode_id: metacode.id
        });
        Metamaps.Topics.add(topic);

        var mapping = new Metamaps.Backbone.Mapping({
            category: "Topic",
            xloc: Metamaps.Create.newTopic.x,
            yloc: Metamaps.Create.newTopic.y,
            topic_id: topic.cid
        });
        Metamaps.Mappings.add(mapping);

        //these can't happen until the value is retrieved, which happens in the line above
        Metamaps.Create.newTopic.hide();

        self.renderTopic(mapping, topic, true, true); // this function also includes the creation of the topic in the database
    },
    getTopicFromAutocomplete: function (id) {
        var self = Metamaps.Topic;

        $(document).trigger(Metamaps.Map.events.editedByActiveMapper);

        Metamaps.Create.newTopic.hide();

        var topic = self.get(id);

        var mapping = new Metamaps.Backbone.Mapping({
            category: "Topic",
            xloc: Metamaps.Create.newTopic.x,
            yloc: Metamaps.Create.newTopic.y,
            topic_id: topic.id
        });
        Metamaps.Mappings.add(mapping);

        self.renderTopic(mapping, topic, true, true);
    },
    getTopicFromSearch: function (event, id) {
        var self = Metamaps.Topic;

        $(document).trigger(Metamaps.Map.events.editedByActiveMapper);

        var topic = self.get(id);

        var nextCoords = Metamaps.Map.getNextCoord();
        var mapping = new Metamaps.Backbone.Mapping({
            category: "Topic",
            xloc: nextCoords.x,
            yloc: nextCoords.y,
            topic_id: topic.id
        });
        Metamaps.Mappings.add(mapping);

        self.renderTopic(mapping, topic, true, true);

        Metamaps.GlobalUI.notifyUser('Topic was added to your map!');

        event.stopPropagation();
        event.preventDefault();
        return false;
    }
}; // end Metamaps.Topic


/*
 *
 *   SYNAPSE
 *
 */
Metamaps.Synapse = {
    // this function is to retrieve a synapse JSON object from the database
    // @param id = the id of the synapse to retrieve
    get: function (id, callback) {
        // if the desired topic is not yet in the local topic repository, fetch it
        if (Metamaps.Synapses.get(id) == undefined) {
            if (!callback) {
                var e = $.ajax({
                    url: "/synapses/" + id + ".json",
                    async: false
                });
                Metamaps.Synapses.add($.parseJSON(e.responseText));
                return Metamaps.Synapses.get(id);
            } else {
                return $.ajax({
                    url: "/synapses/" + id + ".json",
                    success: function (data) {
                        Metamaps.Synapses.add(data);
                        callback(Metamaps.Synapses.get(id));
                    }
                });
            }
        } else {
            if (!callback) {
                return Metamaps.Synapses.get(id);
            } else {
                return callback(Metamaps.Synapses.get(id));
            }
        }
    },
    /*
     *
     *
     */
    renderSynapse: function (mapping, synapse, node1, node2, createNewInDB) {
        var self = Metamaps.Synapse;

        var edgeOnViz;

        var newedge = synapse.createEdge();

        Metamaps.Visualize.mGraph.graph.addAdjacence(node1, node2, newedge.data);
        edgeOnViz = Metamaps.Visualize.mGraph.graph.getAdjacence(node1.id, node2.id);
        synapse.set('edge', edgeOnViz);
        synapse.updateEdge(); // links the synapse and the mapping to the edge

        Metamaps.Control.selectEdge(edgeOnViz);

        var mappingSuccessCallback = function (mappingModel, response) {
            var newSynapseData = {
                mappingid: mappingModel.id,
                synapseid: mappingModel.get('synapse_id')
            };

            $(document).trigger(Metamaps.JIT.events.newSynapse, [newSynapseData]);
        };
        var synapseSuccessCallback = function (synapseModel, response) {
            if (Metamaps.Active.Map) {
                mapping.save({ synapse_id: synapseModel.id }, {
                    success: mappingSuccessCallback
                });
            }
        };

        if (!Metamaps.Settings.sandbox && createNewInDB) {
            if (synapse.isNew()) {
                synapse.save(null, {
                    success: synapseSuccessCallback,
                    error: function (model, response) {
                        console.log('error saving synapse to database');
                    }
                });
            } else if (!synapse.isNew() && Metamaps.Active.Map) {
                mapping.save(null, {
                    success: mappingSuccessCallback
                });
            }
        }
    },
    createSynapseLocally: function () {
        var self = Metamaps.Synapse,
            topic1,
            topic2,
            node1,
            node2,
            synapse,
            mapping;

        $(document).trigger(Metamaps.Map.events.editedByActiveMapper);

        //for each node in this array we will create a synapse going to the position2 node.
        var synapsesToCreate = [];

        topic2 = Metamaps.Topics.get(Metamaps.Create.newSynapse.topic2id);
        node2 = topic2.get('node');

        var len = Metamaps.Selected.Nodes.length;
        if (len == 0) {
            topic1 = Metamaps.Topics.get(Metamaps.Create.newSynapse.topic1id);
            synapsesToCreate[0] = topic1.get('node');
        } else if (len > 0) {
            synapsesToCreate = Metamaps.Selected.Nodes;
        }

        for (var i = 0; i < synapsesToCreate.length; i++) {
            node1 = synapsesToCreate[i];
            topic1 = node1.getData('topic');
            synapse = new Metamaps.Backbone.Synapse({
                desc: Metamaps.Create.newSynapse.description,
                node1_id: topic1.isNew() ? topic1.cid : topic1.id,
                node2_id: topic2.isNew() ? topic2.cid : topic2.id,
            });
            Metamaps.Synapses.add(synapse);

            mapping = new Metamaps.Backbone.Mapping({
                category: "Synapse",
                synapse_id: synapse.cid
            });
            Metamaps.Mappings.add(mapping);

            // this function also includes the creation of the synapse in the database
            self.renderSynapse(mapping, synapse, node1, node2, true);
        } // for each in synapsesToCreate

        Metamaps.Create.newSynapse.hide();
    },
    getSynapseFromAutocomplete: function (id) {
        var self = Metamaps.Synapse,
            topic1,
            topic2,
            node1,
            node2;

        var synapse = self.get(id);

        var mapping = new Metamaps.Backbone.Mapping({
            category: "Synapse",
            synapse_id: synapse.id
        });
        Metamaps.Mappings.add(mapping);

        topic1 = Metamaps.Topics.get(Metamaps.Create.newSynapse.topic1id);
        node1 = topic1.get('node');
        topic2 = Metamaps.Topics.get(Metamaps.Create.newSynapse.topic2id);
        node2 = topic2.get('node');
        Metamaps.Create.newSynapse.hide();

        self.renderSynapse(mapping, synapse, node1, node2, true);
    }
}; // end Metamaps.Synapse


/*
 *
 *   MAP
 *
 */
Metamaps.Map = {
    events: {
        editedByActiveMapper: "Metamaps:Map:events:editedByActiveMapper"
    },
    nextX: 0,
    nextY: 0,
    sideLength: 1,
    turnCount: 0,
    nextXshift: 1,
    nextYshift: 0,
    timeToTurn: 0,
    init: function () {
        var self = Metamaps.Map;

        // prevent right clicks on the main canvas, so as to not get in the way of our right clicks
        $('#center-container').bind('contextmenu', function (e) {
            return false;
        });

        $('.sidebarFork').click(function () {
            self.fork();
        });

        Metamaps.GlobalUI.CreateMap.emptyForkMapForm = $('#fork_map').html();

        self.InfoBox.init();
        self.CheatSheet.init();

        $(document).on(Metamaps.Map.events.editedByActiveMapper, self.editedByActiveMapper);
    },
    launch: function (id) {
        var bb = Metamaps.Backbone;
        var start = function (data) {
            Metamaps.Active.Map = new bb.Map(data.map);
            Metamaps.Mappers = new bb.MapperCollection(data.mappers);
            Metamaps.Topics = new bb.TopicCollection(data.topics);
            Metamaps.Synapses = new bb.SynapseCollection(data.synapses);
            Metamaps.Mappings = new bb.MappingCollection(data.mappings);
            Metamaps.Backbone.attachCollectionEvents();

            var map = Metamaps.Active.Map;
            var mapper = Metamaps.Active.Mapper;

            // add class to .wrapper for specifying whether you can edit the map
            if (map.authorizeToEdit(mapper)) {
                $('.wrapper').addClass('canEditMap');
            }

            // add class to .wrapper for specifying if the map can
            // be collaborated on
            if (map.get('permission') === 'commons') {
                $('.wrapper').addClass('commonsMap');
            }

            // set filter mapper H3 text
            $('#filter_by_mapper h3').html('MAPPERS');

            // build and render the visualization
            Metamaps.Visualize.type = "ForceDirected";
            Metamaps.JIT.prepareVizData();

            // update filters
            Metamaps.Filter.reset(); 

            // reset selected arrays
            Metamaps.Selected.reset();

            // set the proper mapinfobox content
            Metamaps.Map.InfoBox.load();

            // these three update the actual filter box with the right list items
            Metamaps.Filter.checkMetacodes();
            Metamaps.Filter.checkSynapses();
            Metamaps.Filter.checkMappers();

            Metamaps.Realtime.startActiveMap();
            Metamaps.Loading.hide();
        }

        $.ajax({
            url: "/maps/" + id + "/contains.json",
            success: start
        });
    },
    end: function () {
        if (Metamaps.Active.Map) {

            $('.wrapper').removeClass('canEditMap commonsMap');
            Metamaps.Map.resetSpiral();

            $('.rightclickmenu').remove();
            Metamaps.TopicCard.hideCard();
            Metamaps.SynapseCard.hideCard();
            Metamaps.Create.newTopic.hide();
            Metamaps.Create.newSynapse.hide();
            Metamaps.Filter.close();
            Metamaps.Map.InfoBox.close();
            Metamaps.Realtime.endActiveMap();
        }
    },
    fork: function () {
        Metamaps.GlobalUI.openLightbox('forkmap');

        var nodes_data = "",
            synapses_data = "";
        var nodes_array = [];
        var synapses_array = [];
        // collect the unfiltered topics
        Metamaps.Visualize.mGraph.graph.eachNode(function (n) {
            // if the opacity is less than 1 then it's filtered
            if (n.getData('alpha') === 1) {
                var id = n.getData('topic').id;
                nodes_array.push(id);
                var x, y;
                if (n.pos.x && n.pos.y) {
                    x = n.pos.x;
                    y = n.pos.y;
                } else {
                    var x = Math.cos(n.pos.theta) * n.pos.rho;
                    var y = Math.sin(n.pos.theta) * n.pos.rho;
                }
                nodes_data += id + '/' + x + '/' + y + ',';
            }
        });
        // collect the unfiltered synapses
        Metamaps.Synapses.each(function(synapse){
            var desc = synapse.get("desc");

            var descNotFiltered = Metamaps.Filter.visible.synapses.indexOf(desc) > -1;
            // make sure that both topics are being added, otherwise, it 
            // doesn't make sense to add the synapse
            var topicsNotFiltered = nodes_array.indexOf(synapse.get('node1_id')) > -1;
            topicsNotFiltered = topicsNotFiltered && nodes_array.indexOf(synapse.get('node2_id')) > -1;
            if (descNotFiltered && topicsNotFiltered) {
                synapses_array.push(synapse.id);
            }
        });

        synapses_data = synapses_array.join();
        nodes_data = nodes_data.slice(0, -1);

        Metamaps.GlobalUI.CreateMap.topicsToMap = nodes_data;
        Metamaps.GlobalUI.CreateMap.synapsesToMap = synapses_data;

    },
    leavePrivateMap: function(){
        var map = Metamaps.Active.Map;
        Metamaps.Maps.Active.remove(map);
        Metamaps.Maps.Featured.remove(map);
        Metamaps.Router.home();
        Metamaps.GlobalUI.notifyUser('Sorry! That map has been changed to Private.');
    },
    commonsToPublic: function(){
        Metamaps.Realtime.turnOff(true); // true is for 'silence'
        Metamaps.GlobalUI.notifyUser('Map was changed to Public. Editing is disabled.');
        Metamaps.Active.Map.trigger('changeByOther');
    },
    publicToCommons: function(){
        var confirmString = "This map permission has been changed to Commons! ";
        confirmString += "Do you want to reload and enable realtime collaboration?";
        var c = confirm(confirmString);
        if (c) {
            Metamaps.Router.maps(Metamaps.Active.Map.id);
        }
    },
    editedByActiveMapper: function () {
        if (Metamaps.Active.Mapper) {
            Metamaps.Mappers.add(Metamaps.Active.Mapper);
        }
    },
    getNextCoord: function() {
        var self = Metamaps.Map;
        var nextX = self.nextX;
        var nextY = self.nextY;

        var DISTANCE_BETWEEN = 120;

        self.nextX = self.nextX + DISTANCE_BETWEEN * self.nextXshift;
        self.nextY = self.nextY + DISTANCE_BETWEEN * self.nextYshift;

        self.timeToTurn += 1;
        // if true, it's time to turn
        if (self.timeToTurn === self.sideLength) {
            
            self.turnCount += 1;
            // if true, it's time to increase side length
            if (self.turnCount % 2 === 0) {
                self.sideLength += 1;
            }
            self.timeToTurn = 0;

            // going right? turn down
            if (self.nextXshift == 1 && self.nextYshift == 0) {
                self.nextXshift = 0;
                self.nextYshift = 1;
            }
            // going down? turn left
            else if (self.nextXshift == 0 && self.nextYshift == 1) {
                self.nextXshift = -1;
                self.nextYshift = 0;
            }
            // going left? turn up
            else if (self.nextXshift == -1 && self.nextYshift == 0) {
                self.nextXshift = 0;
                self.nextYshift = -1;
            }
            // going up? turn right
            else if (self.nextXshift == 0 && self.nextYshift == -1) {
                self.nextXshift = 1;
                self.nextYshift = 0;
            }
        }

        return {
            x: nextX,
            y: nextY
        }
    },
    resetSpiral: function() {
        Metamaps.Map.nextX = 0;
        Metamaps.Map.nextY = 0;
        Metamaps.Map.nextXshift = 1;
        Metamaps.Map.nextYshift = 0;
        Metamaps.Map.sideLength = 1;
        Metamaps.Map.timeToTurn = 0;
        Metamaps.Map.turnCount = 0;
    },
    exportImage: function() {

        var canvas = {};

        canvas.canvas = document.createElement("canvas");
        canvas.canvas.width  =  1880; // 960;
        canvas.canvas.height = 1260; // 630

        canvas.scaleOffsetX = 1;
        canvas.scaleOffsetY = 1;
        canvas.translateOffsetY = 0;
        canvas.translateOffsetX = 0;
        canvas.denySelected = true;

        canvas.getSize =  function() {
            if(this.size) return this.size;
            var canvas = this.canvas;
            return this.size = {
                width: canvas.width,
                height: canvas.height
            };
        };
        canvas.scale = function(x, y) {
            var px = this.scaleOffsetX * x,
                py = this.scaleOffsetY * y;
            var dx = this.translateOffsetX * (x -1) / px,
                dy = this.translateOffsetY * (y -1) / py;
            this.scaleOffsetX = px;
            this.scaleOffsetY = py;
            this.getCtx().scale(x, y);
            this.translate(dx, dy);
        };
        canvas.translate = function(x, y) {
            var sx = this.scaleOffsetX,
                sy = this.scaleOffsetY;
            this.translateOffsetX += x*sx;
            this.translateOffsetY += y*sy;
            this.getCtx().translate(x, y); 
        };
        canvas.getCtx = function() {
          return this.canvas.getContext("2d");
        };
        // center it
        canvas.getCtx().translate(1880/2, 1260/2);

        var mGraph = Metamaps.Visualize.mGraph;

        var id = mGraph.root;
        var root = mGraph.graph.getNode(id);
        var T = !!root.visited;

        // pass true to avoid basing it on a selection
        Metamaps.JIT.zoomExtents(null, canvas, true);

        var c = canvas.canvas,
            ctx = canvas.getCtx(),
            scale = canvas.scaleOffsetX;

        // draw a grey background
        ctx.fillStyle = '#d8d9da';
        var xPoint = (-(c.width/scale)/2) - (canvas.translateOffsetX/scale),
        yPoint = (-(c.height/scale)/2) - (canvas.translateOffsetY/scale);
        ctx.fillRect(xPoint,yPoint,c.width/scale,c.height/scale);

        // draw the graph
        mGraph.graph.eachNode(function(node) {
           var nodeAlpha = node.getData('alpha');
           node.eachAdjacency(function(adj) {
             var nodeTo = adj.nodeTo;
             if(!!nodeTo.visited === T && node.drawn && nodeTo.drawn) {
               mGraph.fx.plotLine(adj, canvas);
             }
           });
           if(node.drawn) {
             mGraph.fx.plotNode(node, canvas);
           }
           if(!mGraph.labelsHidden) {
             if(node.drawn && nodeAlpha >= 0.95) {
               mGraph.labels.plotLabel(canvas, node);
             } else {
               mGraph.labels.hideLabel(node, false);
             }
           }
           node.visited = !T;
         });
        
        var imageData = {
            encoded_image: canvas.canvas.toDataURL()
        };

        var map = Metamaps.Active.Map;

        var today = new Date();
        var dd = today.getDate();
        var mm = today.getMonth()+1; //January is 0!
        var yyyy = today.getFullYear();
        if(dd<10) {
            dd='0'+dd
        } 
        if(mm<10) {
            mm='0'+mm
        }
        today = mm+'/'+dd+'/'+yyyy;

        var mapName = map.get("name").split(" ").join([separator = '-']);
        var downloadMessage = "";
        downloadMessage += "Captured map screenshot! ";
        downloadMessage += "<a href='" + imageData.encoded_image + "' ";
        downloadMessage += "download='metamap-" + map.id + "-" + mapName + "-" + today + ".png'>DOWNLOAD</a>";
        Metamaps.GlobalUI.notifyUser(downloadMessage);

        $.ajax({
            type: "POST",
            dataType: 'json',
            url: "/maps/" + Metamaps.Active.Map.id + "/upload_screenshot",
            data: imageData,
            success: function (data) {
                console.log('successfully uploaded map screenshot');
            },
            error: function () {
                console.log('failed to save map screenshot');
            }
        });
    }
};


/*
 *
 *   CHEATSHEET
 *
 */
Metamaps.Map.CheatSheet = {
    init: function () {
        // tab the cheatsheet
        $('#cheatSheet').tabs();
        $('#quickReference').tabs().addClass("ui-tabs-vertical ui-helper-clearfix");
        $("#quickReference .ui-tabs-nav li").removeClass("ui-corner-top").addClass("ui-corner-left");
        
        // id = the id of a vimeo video
        var switchVideo = function (element, id) {
            $('.tutorialItem').removeClass("active");
            $(element).addClass("active");
            $('#tutorialVideo').attr('src','//player.vimeo.com/video/'+id);
        };

        $('#gettingStarted').click(function() {
            //switchVideo(this,'88334167');
        });
        $('#upYourSkillz').click(function() {
            //switchVideo(this,'100118167');
        });
        $('#advancedMapping').click(function() {
            //switchVideo(this,'88334167');
        });
    }
}; // end Metamaps.Map.CheatSheet


/*
 *
 *   INFOBOX
 *
 */
Metamaps.Map.InfoBox = {
    isOpen: false,
    changing: false,
    selectingPermission: false,
    changePermissionText: "<div class='tooltips'>As the creator, you can change the permission of this map, but the permissions of the topics and synapses on it must be changed independently.</div>",
    nameHTML: '<span class="best_in_place best_in_place_name" id="best_in_place_map_{{id}}_name" data-url="/maps/{{id}}" data-object="map" data-attribute="name" data-type="textarea" data-activator="#mapInfoName">{{name}}</span>',
    descHTML: '<span class="best_in_place best_in_place_desc" id="best_in_place_map_{{id}}_desc" data-url="/maps/{{id}}" data-object="map" data-attribute="desc" data-nil="Click to add description..." data-type="textarea" data-activator="#mapInfoDesc">{{desc}}</span>',
    init: function () {
        var self = Metamaps.Map.InfoBox;

        $('.mapInfoIcon').click(self.toggleBox);
        $('.mapInfoBox').click(function(event){ 
            event.stopPropagation();
        });
        $('body').click(self.close);

        self.attachEventListeners();

        self.generateBoxHTML = Hogan.compile($('#mapInfoBoxTemplate').html());
    },
    toggleBox: function (event) {
        var self = Metamaps.Map.InfoBox;

        if (self.isOpen) self.close();
        else self.open();

        event.stopPropagation();
    },
    open: function () {
        var self = Metamaps.Map.InfoBox;
        $('.mapInfoIcon div').addClass('hide');
        if (!self.isOpen && !self.changing) {
            self.changing = true;
            $('.mapInfoBox').fadeIn(200, function () {
                self.changing = false;
                self.isOpen = true;
            });
        }
    },
    close: function () {
        var self = Metamaps.Map.InfoBox;

        $('.mapInfoIcon div').removeClass('hide');
        if (!self.changing) {
            self.changing = true;
            $('.mapInfoBox').fadeOut(200, function () {
                self.changing = false;
                self.isOpen = false;
                self.hidePermissionSelect();
                $('.mapContributors .tip').hide();
            });
        }
    },
    load: function () {
        var self = Metamaps.Map.InfoBox;

        var map = Metamaps.Active.Map;

        var obj = map.pick("permission","contributor_count","topic_count","synapse_count");

        var isCreator = map.authorizePermissionChange(Metamaps.Active.Mapper);
        var canEdit = map.authorizeToEdit(Metamaps.Active.Mapper);
        var shareable = map.get('permission') !== 'private';

        obj["name"] = canEdit ? Hogan.compile(self.nameHTML).render({id: map.id, name: map.get("name")}) : map.get("name");
        obj["desc"] = canEdit ? Hogan.compile(self.descHTML).render({id: map.id, desc: map.get("desc")}) : map.get("desc");
        obj["map_creator_tip"] = isCreator ? self.changePermissionText : "";
        obj["contributors_class"] = Metamaps.Mappers.length > 1 ? "multiple" : "";
        obj["contributors_class"] += Metamaps.Mappers.length === 2 ? " mTwo" : "";
        obj["contributor_image"] = Metamaps.Mappers.length > 0 ? Metamaps.Mappers.models[0].get("image") : "/assets/user.png";
        obj["contributor_list"] = self.createContributorList();
        obj["user_name"] = isCreator ? "You" : map.get("user_name");
        obj["created_at"] = map.get("created_at_clean");
        obj["updated_at"] = map.get("updated_at_clean");

        var classes = isCreator ? "yourMap" : "";
        classes += canEdit ? " canEdit" : "";
        classes += shareable ? " shareable" : "";
        $(".mapInfoBox").removeClass("shareable yourMap canEdit")
            .addClass(classes)
            .html(self.generateBoxHTML.render(obj));

        self.attachEventListeners();
    },
    attachEventListeners: function () {
        var self = Metamaps.Map.InfoBox;

        $('.mapInfoBox.canEdit .best_in_place').best_in_place();

        // because anyone who can edit the map can change the map title
        var bipName = $('.mapInfoBox .best_in_place_name');
        bipName.unbind("best_in_place:activate").bind("best_in_place:activate", function () {
            var $el = bipName.find('textarea');
            var el = $el[0];

            $el.attr('maxlength', '140');

            $('.mapInfoName').append('<div class="nameCounter forMap"></div>');

            var callback = function (data) {
                $('.nameCounter.forMap').html(data.all + '/140');
            };
            Countable.live(el, callback);
        });
        bipName.unbind("best_in_place:deactivate").bind("best_in_place:deactivate", function () {
            $('.nameCounter.forMap').remove();
        });

        $('.mapInfoName .best_in_place_name').unbind("ajax:success").bind("ajax:success", function () {
            var name = $(this).html();
            Metamaps.Active.Map.set('name', name);
            Metamaps.Active.Map.trigger('saved');
        });

        $('.mapInfoDesc .best_in_place_desc').unbind("ajax:success").bind("ajax:success", function () {
            var desc = $(this).html();
            Metamaps.Active.Map.set('desc', desc);
            Metamaps.Active.Map.trigger('saved');
        });

        $('.yourMap .mapPermission').unbind().click(self.onPermissionClick);
        // .yourMap in the unbind/bind is just a namespace for the events
        // not a reference to the class .yourMap on the .mapInfoBox
        $('.mapInfoBox.yourMap').unbind('.yourMap').bind('click.yourMap', self.hidePermissionSelect);

        $('.yourMap .mapInfoDelete').unbind().click(self.deleteActiveMap);

        $('.mapContributors span, #mapContribs').unbind().click(function(event){
            $('.mapContributors .tip').toggle();
            event.stopPropagation();
        });
        $('.mapContributors .tip').unbind().click(function(event){
            event.stopPropagation();
        });
        $('.mapContributors .tip li a').click(Metamaps.Router.intercept);

        $('.mapInfoBox').unbind('.hideTip').bind('click.hideTip', function(){
            $('.mapContributors .tip').hide();
        });
    },
    updateNameDescPerm: function(name, desc, perm) {
        $('.mapInfoName .best_in_place_name').html(name);
        $('.mapInfoDesc .best_in_place_desc').html(desc);
        $('.mapInfoBox .mapPermission').removeClass('commons public private').addClass(perm);
    },
    createContributorList: function () {
        var self = Metamaps.Map.InfoBox;

        var string = "";
        string += "<ul>";

        Metamaps.Mappers.each(function(m){
            string += '<li><a href="/explore/mapper/' + m.get("id") + '">' + '<img class="rtUserImage" width="25" height="25" src="' + m.get("image") + '" />' + m.get("name") + '</a></li>';
        });
        
        string += "</ul>";
        return string;
    },
    updateNumbers: function () {
        var self = Metamaps.Map.InfoBox;
        var mapper = Metamaps.Active.Mapper;

        var contributors_class = "";
        if (Metamaps.Mappers.length === 2) contributors_class = "multiple mTwo";
        else if (Metamaps.Mappers.length > 2) contributors_class = "multiple";

        var contributors_image = "/assets/user.png";
        if (Metamaps.Mappers.length > 0) {
            // get the first contributor and use their image
            contributors_image = Metamaps.Mappers.models[0].get("image");
        }
        $('.mapContributors img').attr('src', contributors_image).removeClass('multiple mTwo').addClass(contributors_class);
        $('.mapContributors span').text(Metamaps.Mappers.length)
        $('.mapContributors .tip').html(self.createContributorList());
        $('.mapTopics').text(Metamaps.Topics.length);
        $('.mapSynapses').text(Metamaps.Synapses.length);

        $('.mapEditedAt').html('<span>Last edited: </span>' + Metamaps.Util.nowDateFormatted());
    },
    onPermissionClick: function (event) {
        var self = Metamaps.Map.InfoBox;

        if (!self.selectingPermission) {
            self.selectingPermission = true;
            $(this).addClass('minimize'); // this line flips the drop down arrow to a pull up arrow
            if ($(this).hasClass('commons')) {
                $(this).append('<ul class="permissionSelect"><li class="public"></li><li class="private"></li></ul>');
            } else if ($(this).hasClass('public')) {
                $(this).append('<ul class="permissionSelect"><li class="commons"></li><li class="private"></li></ul>');
            } else if ($(this).hasClass('private')) {
                $(this).append('<ul class="permissionSelect"><li class="commons"></li><li class="public"></li></ul>');
            }
            $('.mapPermission .permissionSelect li').click(self.selectPermission);
            event.stopPropagation();
        }
    },
    hidePermissionSelect: function () {
        var self = Metamaps.Map.InfoBox;

        self.selectingPermission = false;
        $('.mapPermission').removeClass('minimize'); // this line flips the pull up arrow to a drop down arrow
        $('.mapPermission .permissionSelect').remove();
    },
    selectPermission: function (event) {
        var self = Metamaps.Map.InfoBox;

        self.selectingPermission = false;
        var permission = $(this).attr('class');
        var permBefore = Metamaps.Active.Map.get('permission');
        Metamaps.Active.Map.save({
            permission: permission
        });
        Metamaps.Active.Map.updateMapWrapper();
        if (permBefore !== 'commons' && permission === 'commons') {
            Metamaps.Realtime.setupSocket();
            Metamaps.Realtime.turnOn();
        }
        else if (permBefore === 'commons' && permission === 'public') {
            Metamaps.Realtime.turnOff(true); // true is to 'silence' 
            // the notification that would otherwise be sent
        }
        shareable = permission === 'private' ? '' : 'shareable';
        $('.mapPermission').removeClass('commons public private minimize').addClass(permission);
        $('.mapPermission .permissionSelect').remove();
        $('.mapInfoBox').removeClass('shareable').addClass(shareable);
        event.stopPropagation();
    },
    deleteActiveMap: function () {
        var confirmString = 'Are you sure you want to delete this map? ';
        confirmString += 'This action is irreversible. It will not delete the topics and synapses on the map.';

        var doIt = confirm(confirmString);
        var map = Metamaps.Active.Map;
        var mapper = Metamaps.Active.Mapper;
        var authorized = map.authorizePermissionChange(mapper);

        if (doIt && authorized) {
            Metamaps.Map.InfoBox.close();
            Metamaps.Maps.Active.remove(map);
            Metamaps.Maps.Featured.remove(map);
            Metamaps.Maps.Mine.remove(map);
            map.destroy();
            Metamaps.Router.home();
            Metamaps.GlobalUI.notifyUser('Map eliminated!');
        }
        else if (!authorized) {
            alert('Hey now. We can\'t just go around willy nilly deleting other people\'s maps now can we? Run off and find something constructive to do, eh?');
        }
    }
}; // end Metamaps.Map.InfoBox

/*
*
* Account Settings
*
*/
Metamaps.Account = {
    listenersInitialized: false,
    init: function () {
        var self = Metamaps.Account;


    },
    initListeners: function(){
        var self = Metamaps.Account;

        $('#user_image').change(self.showImagePreview);
        self.listenersInitialized = true;
    },
    toggleChangePicture: function(){
        var self = Metamaps.Account;

        $('.userImageMenu').toggle();
        if (!self.listenersInitialized) self.initListeners();
    },
    openChangePicture: function(){
        var self = Metamaps.Account;

        $('.userImageMenu').show();
        if (!self.listenersInitialized) self.initListeners();
    },
    closeChangePicture: function(){
        var self = Metamaps.Account;

        $('.userImageMenu').hide();
    },
    showLoading: function(){
        var self = Metamaps.Account;

        var loader = new CanvasLoader('accountPageLoading');
        loader.setColor('#4FC059'); // default is '#000000'
        loader.setDiameter(28); // default is 40
        loader.setDensity(41); // default is 40
        loader.setRange(0.9); // default is 1.3
        loader.show(); // Hidden by default
        $('#accountPageLoading').show();
    },
    showImagePreview: function(){
        var self = Metamaps.Account;

        var file = $('#user_image')[0].files[0];

        var reader = new FileReader();

        reader.onload = function(e) {
            var $canvas = $('<canvas>').attr({
                width: 84,
                height: 84
            });
            var context = $canvas[0].getContext('2d');
            var imageObj = new Image();

            imageObj.onload = function() {
                $('.userImageDiv canvas').remove();
                $('.userImageDiv img').hide();

                var imgWidth = imageObj.width;
                var imgHeight = imageObj.height;

                var dimensionToMatch = imgWidth > imgHeight ? imgHeight : imgWidth;
                // draw cropped image
                var nonZero = Math.abs(imgHeight - imgWidth) / 2;
                var sourceX = dimensionToMatch === imgWidth ? 0 : nonZero;
                var sourceY = dimensionToMatch === imgHeight ? 0 : nonZero;
                var sourceWidth = dimensionToMatch;
                var sourceHeight = dimensionToMatch;
                var destX = 0;
                var destY = 0;
                var destWidth = 84;
                var destHeight = 84;

                context.drawImage(imageObj, sourceX, sourceY, sourceWidth, sourceHeight, destX, destY, destWidth, destHeight);
                $('.userImageDiv').prepend($canvas);
            };
            imageObj.src = reader.result;
        };

        if (file) {
            reader.readAsDataURL(file);
            $('.userImageMenu').hide();
            $('#remove_image').val('0');
        }
    },
    removePicture: function(){
        var self = Metamaps.Account;

        $('.userImageDiv canvas').remove();
        $('.userImageDiv img').attr('src', '/assets/user.png').show();
        $('.userImageMenu').hide();

        var input = $('#user_image');
        input.replaceWith(input.val('').clone(true));
        $('#remove_image').val('1');
    },
    changeName: function(){
        $('.accountName').hide();
        $('.changeName').show();
    },
    showPass: function(){
        $(".toHide").show();
        $(".changePass").hide();
    },
    hidePass: function(){
        $(".toHide").hide();
        $(".changePass").show();

        $('#current_password').val('');
        $('#user_password').val('');
        $('#user_password_confirmation').val('');
    }
};

/*
 *
 *   MAPPER
 *
 */
Metamaps.Mapper = {
    // this function is to retrieve a mapper JSON object from the database
    // @param id = the id of the mapper to retrieve
    get: function (id, callback) {
        return $.ajax({
            url: "/users/" + id + ".json",
            success: function (data) {
                callback(new Metamaps.Backbone.Mapper(data));
            }
        });
    }
}; // end Metamaps.Mapper


/*
 *
 *   ADMIN
 *
 */

Metamaps.Admin = {
    selectMetacodes: [],
    allMetacodes: [],
    init: function () {
        var self = Metamaps.Admin;

        $('#metacodes_value').val(self.selectMetacodes.toString());
    },
    selectAll: function () {
        var self = Metamaps.Admin; 

        $('.editMetacodes li').removeClass('toggledOff');
        self.selectMetacodes = self.allMetacodes.slice(0);
        $('#metacodes_value').val(self.selectMetacodes.toString());
    },
    deselectAll: function () {
        var self = Metamaps.Admin; 

        $('.editMetacodes li').addClass('toggledOff');
        self.selectMetacodes = [];
        $('#metacodes_value').val(0);
    },
    liClickHandler: function () {
        var self = Metamaps.Admin;

        if ($(this).attr('class') != 'toggledOff') {
          $(this).addClass('toggledOff');
          var value_to_remove = $(this).attr('id');
          self.selectMetacodes.splice(self.selectMetacodes.indexOf(value_to_remove), 1);
          $('#metacodes_value').val(self.selectMetacodes.toString());
        }
        else if ($(this).attr('class') == 'toggledOff') {
          $(this).removeClass('toggledOff');
          self.selectMetacodes.push($(this).attr('id'));
          $('#metacodes_value').val(self.selectMetacodes.toString());
        }
    },
    validate: function () {
        var self = Metamaps.Admin;

        if (self.selectMetacodes.length == 0) {
          alert('Would you pretty please select at least one metacode for the set?');
          return false;
        }
    }
};

