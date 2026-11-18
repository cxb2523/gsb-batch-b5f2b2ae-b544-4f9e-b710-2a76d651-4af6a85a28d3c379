"use strict";

function hash(audio) {
  const h = [audio.name, audio.lastModified, audio.type, audio.size].map(e=>e+"").join('//');
  if (!h) {
    return Date.now();
  }
  return encodeURIComponent(h.replace(/\s/g, ""));
}


/*
  Constructor
  @param Object params
    - Function@Promise onBeforeAdded
    - HTMLElement element
*/
function Playlist(params) {
  this.element = params.element;
  this.coverEl = document.querySelector("img#cover");
  this.shuffle = false;
  this.loop = true;
  this.element.scrollTo = function(y, t) {
    t = t > 0 ? Math.floor(t / 4) : 40;
    let step = (y - this.scrollTop) / t * 40;
    let that = this;
    function aux() {
      t -= 40;
      that.scrollTop += step;
      if (t > 0) {
        setTimeout(aux, 40);
      } else {
        that.scrollTop = y;
      }
    }
    aux();
  };
  this.params = params;

  this.onItemSelected = this.onItemSelected.bind(this);
  this.onItemRemoved = this.onItemRemoved.bind(this);
  this.onItemCleared = this.onItemCleared.bind(this);
  this.selectPrevious = this.selectPrevious.bind(this);
  this.selectNext = this.selectNext.bind(this);

  // Hash Map
  this.list = [];
  this.orderedlist = [];
  this.hashes = [];
  return this;
}

Playlist.prototype = {
  addAll(medias) {
    for(var i = 0;i < medias.length; i++)
      this.add(medias[i]);
  },

  /*
    Adds an media file to the playlist
    @param File media: The file to add
  */
  add(media) {
    if (media === null || (media.type.match("audio") != "audio" &&
                          media.type.match("video") != "video")
                       || this.hashes.includes(hash(media))) {
      return;
    }
    this.element.classList.add("loading");

    let item = new PlaylistItem({
      type: media.type.match("audio") == "audio" ? "audio" : "video",
      media,
      playlist: this
    });
    this.list.push(item);
    this.orderedlist.push(item);
    this.hashes.push(item.hash);
    if (!this.selectedItem) {
      this.onItemSelected(item);
    }
    this.element.classList.remove("loading");
    return item;
  },
  doShuffle() {
    for(var i = 0; i < this.list.length; i++) {
      var j = i+Math.floor((this.list.length-i)*Math.random());
      var tmp = this.list[i];
      this.list[i] = this.list[j];
      this.list[j] = tmp;
    }
  },
  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.shuffle) {
      this.doShuffle();
    } else {
      this.list = [...this.orderedlist];
    }
  },
  selectPrevious() {
    var item = this.selectedItem;
    var itemIndex = this.list.findIndex(i => i.hash === item.hash);
    var nextItemIndex = (this.list.length+itemIndex-1)%this.list.length;
    var nextItem = this.list[nextItemIndex];
    item.unselect();
    if (nextItemIndex === this.list.length - 1 && this.shuffle) {
      this.doShuffle();
    }
    this.onItemSelected(nextItem);
  },

  selectNext() {
    var item = this.selectedItem;
    var itemIndex = this.list.findIndex(i => i.hash === item.hash);
    var nextItemIndex = (itemIndex+1)%this.list.length;
    var nextItem = this.list[nextItemIndex];
    item.unselect();
    if (nextItemIndex === 0 && this.shuffle) {
      this.doShuffle();
    }
    this.onItemSelected(nextItem);
  },

  onItemSelected(item) {
    if (this.selectedItem) {
      this.selectedItem.unselect();
    }
    item.select();
    this.selectedItem = item;
    this.params.onItemSelected(item);
  },

  onItemRemoved(item) {
    let isSelected = this.selectedItem && this.selectedItem.hash === item.hash;
    if (isSelected) {
      /* Notify the player first so it stops playback and releases the
         visualizer animation frame and object URLs before the selection
         moves on: a destroyed item must never be referenced afterwards. */
      this.params.onItemRemoved(item);
    }
    if (this.list.length === 1) {
      this.onItemCleared();
    } else if (isSelected) {
      this.selectNext();
    }
    item.destroy();
    this.list = this.list.filter(i => i.hash !== item.hash);
    this.orderedlist = this.orderedlist.filter(i => i.hash !== item.hash);
    this.hashes = this.hashes.filter(h => h !== item.hash);
  },

  clear() {
    if (this.list.length === 0) {
      return;
    }
    if (this.selectedItem) {
      /* Release the current track's resources before tearing the list down. */
      this.params.onItemRemoved(this.selectedItem);
    }
    for (let item of this.list) {
      item.destroy();
    }
    this.list = [];
    this.orderedlist = [];
    this.hashes = [];
    this.onItemCleared();
  },

  onItemCleared() {
    this.selectedItem = null;
    this.params.onItemCleared();
  },

  onItemUpdated(item) {
    /* A tag finished loading after the item was selected: forward it so
       the player can refresh the header/cover without re-selecting the
       item (which would restart playback and leak object URLs). */
    if (this.selectedItem && this.selectedItem.hash === item.hash
        && this.params.onItemUpdated) {
      this.params.onItemUpdated(item);
    }
  }
};

function PlaylistItem(params) {
  this.playlist = params.playlist;
  this.hash = hash(params.media);
  this.media = params.media;
  this.type = params.type;
  this.onItemSelected = params.playlist.onItemSelected;
  this.onItemRemoved = params.playlist.onItemRemoved;
  this.pic = null;
  var p;
  [this.tag, p] = Utils.readTag(this.media);
  this.createDOM();
  p.then(tag => {
    if (!tag) return;
    this.tag = tag;
    this.pic = tag.pic;
    this.createDOM();
  });
  return this
}

PlaylistItem.prototype = {
  createDOM() {
    var item = this.element ?
      this.element :
      Element("li", {
        title: Utils.getTooltipForTag(this.tag),
        onClick: () => this.onItemSelected(this),
        parent: this.playlist.element
      });
    item.setAttribute('title', Utils.getTooltipForTag(this.tag));
    item.innerHTML = "";

    var itemWrap = Element("a", {
      href: "#",
      parent: item
    });

    /* var coverDiv = */
    Element("div", {
      class: "cover",
      parent: itemWrap
    });

    var textContainer = Element("p", {
      class: "text-container",
      parent: itemWrap
    });

    Element("span", {
      class: "title",
      content: this.tag.title,
      parent: textContainer
    });

    if (this.tag.artist) {
      Element("span", {
        class: "artist",
        content: this.tag.artist,
        parent: textContainer
      });
    }

    Element("button", {
      class: "cross",
      onClick: (e) => {
        this.onItemRemoved(this);
        e.stopPropagation();
      },
      parent: itemWrap
    });

    this.element = item;
    if (this.element.classList.contains("playing")) {
      /* The tag resolved while this item is selected: refresh the
         header/cover instead of re-selecting, which would restart
         playback and revoke the object URL currently in use. */
      this.playlist.onItemUpdated(this);
    }
    return item;
  },

  select() {
    this.element.classList.add("playing");
    this.playlist.coverEl.src = this.pic == null ? "" : this.pic;
  },

  unselect() {
    this.element.classList.remove("playing");
    this.playlist.coverEl.src = "";
  },

  destroy() {
    this.element.remove();
    URL.revokeObjectURL(this.pic);
    this.media = null;
    /* The cover is owned by the selection flow (select/unselect and the
       player's releaseMedia): destroying a background item must not
       blank the cover of the track that is now playing. */
  }
};

