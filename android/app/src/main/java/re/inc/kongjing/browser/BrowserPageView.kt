package re.inc.kongjing.browser

import android.content.Context
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.webkit.WebView
import org.json.JSONTokener

/** Preserve WebView's native text actions and add the extension context-menu group. */
class BrowserPageView(context:Context,private val extensionsEnabled:()->Boolean,private val selected:(String)->Unit):WebView(context){
    private fun wrap(original:ActionMode.Callback)=object:ActionMode.Callback{
        override fun onCreateActionMode(mode:ActionMode,menu:Menu):Boolean{
            val created=original.onCreateActionMode(mode,menu)
            if(created&&extensionsEnabled()&&menu.findItem(EXTENSION_ACTION)==null)menu.add(Menu.NONE,EXTENSION_ACTION,Menu.NONE,"扩展").setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
            return created
        }
        override fun onPrepareActionMode(mode:ActionMode,menu:Menu)=original.onPrepareActionMode(mode,menu)
        override fun onActionItemClicked(mode:ActionMode,item:MenuItem):Boolean{
            if(item.itemId!=EXTENSION_ACTION)return original.onActionItemClicked(mode,item)
            evaluateJavascript("String(window.getSelection())"){json->
                val text=runCatching{JSONTokener(json).nextValue() as? String}.getOrNull().orEmpty()
                if(text.isNotBlank())selected(text.take(10000))
                mode.finish()
            };return true
        }
        override fun onDestroyActionMode(mode:ActionMode)=original.onDestroyActionMode(mode)
    }
    override fun startActionMode(callback:ActionMode.Callback):ActionMode?=super.startActionMode(wrap(callback))
    override fun startActionMode(callback:ActionMode.Callback,type:Int):ActionMode?=super.startActionMode(wrap(callback),type)
    companion object{private const val EXTENSION_ACTION=0x4b4a140}
}
