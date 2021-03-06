define(function(require, exports, module) {
    
var t = {};

t.logoContent = '<div class="logo">METAMAPS</div>';
t.logoContent += '<ul class="bottomLinks">';
t.logoContent += '<li onclick="Metamaps.GlobalUI.openLightbox(\'about\')">About /&nbsp;</li>';
t.logoContent += '<li onclick="Metamaps.GlobalUI.openLightbox(\'colophon\')">Colophon /&nbsp;</li>';
t.logoContent += '<li onclick="Metamaps.GlobalUI.openLightbox(\'donate\')">Donate! /&nbsp;</li>';
t.logoContent += '<li onclick="Metamaps.GlobalUI.openLightbox(\'getInvolved\')">Get Involved!</li>';
t.logoContent += '</ul>';

/* logged out explore maps bars */
  t.activeContent = '<a href="/explore/active" class="active activeMaps exploreMapsButton"><div class="exploreMapsIcon"></div>Recently Active Maps</a>';
  t.activeContent += '<a href="/explore/featured" class="featuredMaps exploreMapsButton"><div class="exploreMapsIcon"></div>Featured Maps</a>';

  t.featuredContent = '<a href="/explore/active" class="activeMaps exploreMapsButton"><div class="exploreMapsIcon"></div>Recently Active Maps</a>';
  t.featuredContent += '<a href="/explore/featured" class="active featuredMaps exploreMapsButton"><div class="exploreMapsIcon"></div>Featured Maps</a>';

/* logged in explore maps bars */
  t.mineAuthContent = '<a href="/explore/mine" class="active myMaps exploreMapsButton"><div class="exploreMapsIcon"></div>My Maps</a>';
  t.mineAuthContent += '<a href="/" class="activeMaps exploreMapsButton"><div class="exploreMapsIcon"></div>Recently Active</a>';
  t.mineAuthContent += '<a href="/explore/featured" class="featuredMaps exploreMapsButton"><div class="exploreMapsIcon"></div>Featured</a>';

  t.activeAuthContent = '<a href="/explore/mine" class="myMaps exploreMapsButton"><div class="exploreMapsIcon"></div>My Maps</a>';
  t.activeAuthContent += '<a href="/" class="active activeMaps exploreMapsButton"><div class="exploreMapsIcon"></div>Recently Active</a>';
  t.activeAuthContent += '<a href="/explore/featured" class="featuredMaps exploreMapsButton"><div class="exploreMapsIcon"></div>Featured</a>';

  t.featuredAuthContent = '<a href="/explore/mine" class="myMaps exploreMapsButton"><div class="exploreMapsIcon"></div>My Maps</a>';
  t.featuredAuthContent += '<a href="/" class="activeMaps exploreMapsButton"><div class="exploreMapsIcon"></div>Recently Active</a>';
  t.featuredAuthContent += '<a href="/explore/featured" class="active featuredMaps exploreMapsButton"><div class="exploreMapsIcon"></div>Featured</a>';

    module.exports = t;
});
