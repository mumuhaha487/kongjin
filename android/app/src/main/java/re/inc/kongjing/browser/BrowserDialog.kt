package re.inc.kongjing.browser

import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties

@Composable fun BrowserDialog(onDismissRequest:()->Unit,title:@Composable ()->Unit,text:@Composable ()->Unit,confirmButton:@Composable ()->Unit,dismissButton:@Composable ()->Unit){
    AlertDialog(onDismissRequest=onDismissRequest,title={ProvideTextStyle(MaterialTheme.typography.titleLarge){title()}},text=text,confirmButton=confirmButton,dismissButton=dismissButton,containerColor=MaterialTheme.colorScheme.surface,
        modifier=Modifier.width((LocalConfiguration.current.screenWidthDp-48).coerceAtMost(400).dp),shape=RoundedCornerShape(20.dp),properties=DialogProperties(usePlatformDefaultWidth=false))
}
